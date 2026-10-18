import express from 'express';
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.CRAWLER_TIMEOUT_MS || '30000', 10);
const MAX_CONCURRENT = parseInt(process.env.CRAWLER_MAX_CONCURRENT || '5', 10);
const USER_AGENT = process.env.CRAWLER_USER_AGENT || 'Insight-Hub-Crawler/1.0';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeStyle: 'fenced',
});

// ---------------------------------------------------------------------------------------------------------------
// SSRF protection (Release C). The crawler fetches URLs that come from third-party procurement records, so it must
// never reach loopback, private, link-local (cloud metadata), CGNAT, multicast or reserved addresses, including via
// redirects and sub-resources. Optional shared secret: CRAWLER_SERVICE_TOKEN (Authorization: Bearer <token>).
// ---------------------------------------------------------------------------------------------------------------
const SERVICE_TOKEN = process.env.CRAWLER_SERVICE_TOKEN || '';
const BLOCKED_HOSTS = /(^|\.)(localhost|localdomain|internal|local|lan|home|corp|intranet|metadata|metadata\.google\.internal)$/i;

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function expandIpv6(address) {
  let value = address.toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const v4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[2].split('.').map(Number);
    value = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
  return parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : parsed;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const g = expandIpv6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (any spelling), IPv4-compatible and NAT64 addresses: judge the embedded IPv4 address.
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) return ipv4Private(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4Private(embedded);
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  if (g[0] === 0x2002) return ipv4Private(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`); // 6to4
  return false;
}

// Validated addresses per host. Connections are made to these exact addresses (see pinnedFetch), so a hostname that
// re-resolves to a private address after validation (DNS rebinding) is never reached.
const hostVerdicts = new Map();
async function resolveAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.test(host)) return null;
  if (net.isIP(host)) return isPrivateAddress(host) ? null : [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  const cached = hostVerdicts.get(host);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  let addresses = null;
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    if (answers.length > 0 && answers.every((answer) => !isPrivateAddress(answer.address))) addresses = answers;
  } catch {
    addresses = null;
  }
  hostVerdicts.set(host, { addresses, expires: Date.now() + 60_000 });
  return addresses;
}

async function hostAllowed(hostname) {
  return (await resolveAllowed(hostname)) !== null;
}

const MAX_RESOURCE_BYTES = parseInt(process.env.CRAWLER_MAX_RESOURCE_BYTES || String(15 * 1024 * 1024), 10);
// Process-wide ceiling on response bytes held in memory at once, across every page and routed sub-resource, so a
// page referencing many large resources cannot exhaust the crawler. Requests that would exceed it are aborted.
const MAX_BUFFERED_BYTES = parseInt(process.env.CRAWLER_MAX_BUFFERED_BYTES || String(64 * 1024 * 1024), 10);
const MAX_ROUTED_REQUESTS = parseInt(process.env.CRAWLER_MAX_ROUTED_REQUESTS || '16', 10);
let bufferedBytes = 0;
function releaseBytes(n) {
  bufferedBytes = Math.max(0, bufferedBytes - n);
}
let routedInFlight = 0;
const routedWaiters = [];
async function withRoutedSlot(work) {
  if (routedInFlight >= MAX_ROUTED_REQUESTS) await new Promise((resolve) => routedWaiters.push(resolve));
  routedInFlight += 1;
  try {
    return await work();
  } finally {
    routedInFlight -= 1;
    routedWaiters.shift()?.();
  }
}
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade', 'proxy-connection']);

/**
 * One request from Node, connected only to a validated address. The socket timeout only fires when the connection
 * is idle, so a wall-clock deadline (TIMEOUT_MS, or the caller's absolute deadlineAt if sooner) also bounds a
 * response that trickles in slowly.
 */
function pinnedRequest(target, addresses, { method, headers, body, deadlineAt }) {
  const pinned = addresses[0];
  const client = target.protocol === 'https:' ? https : http;
  const outgoing = { ...headers, 'accept-encoding': 'identity' };
  delete outgoing.host;
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let deadline = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      releaseBytes(size);
      req.destroy(error);
      reject(error);
    };
    const req = client.request(
      target,
      {
        method,
        headers: outgoing,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        lookup: (_host, options, callback) => {
          if (options && options.all) return callback(null, [pinned]);
          return callback(null, pinned.address, pinned.family);
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          if (size + chunk.length > MAX_RESOURCE_BYTES) return fail(new Error('resource too large'));
          if (bufferedBytes + chunk.length > MAX_BUFFERED_BYTES) return fail(new Error('crawler buffer budget exceeded'));
          size += chunk.length;
          bufferedBytes += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', () => {
          const outHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined || HOP_BY_HOP.has(key)) continue;
            outHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
          }
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          // The caller releases the body's bytes (releaseBytes) once it has handed the body on.
          resolve({ status: res.statusCode || 502, headers: outHeaders, body: Buffer.concat(chunks) });
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('response aborted')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    const budget = Math.min(TIMEOUT_MS, deadlineAt ? deadlineAt - Date.now() : TIMEOUT_MS);
    deadline = setTimeout(() => fail(new Error('request deadline exceeded')), Math.max(0, budget));
    if (body) req.write(body);
    req.end();
  });
}

const ALLOWED_PORTS = ['80', '443', '8080', '8443'];
const MAX_REDIRECTS = 5;

/**
 * Fetches a URL from Node, following redirects here (Chromium does not route redirects of fulfilled responses, so
 * they must never reach it): every hop is re-validated and connected to its validated address.
 */
async function pinnedFetch(rawUrl, init) {
  let target = new URL(rawUrl);
  // Every hop shares one absolute deadline, so redirects cannot each take a fresh full timeout.
  let request = { ...init, deadlineAt: init.deadlineAt ?? Date.now() + TIMEOUT_MS };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('blocked protocol');
    if (target.username || target.password) throw new Error('credentials in URL');
    if (target.port && !ALLOWED_PORTS.includes(target.port)) throw new Error('blocked port');
    const addresses = await resolveAllowed(target.hostname);
    if (!addresses) throw new Error('blocked destination');
    const response = await pinnedRequest(target, addresses, request);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      releaseBytes(response.body.length);
      const next = new URL(location, target);
      if (next.origin !== target.origin) {
        // Origin-bound credentials never follow a redirect to another origin.
        const headers = { ...(request.headers || {}) };
        for (const key of Object.keys(headers)) {
          if (['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())) delete headers[key];
        }
        request = { ...request, headers };
      }
      target = next;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST')) {
        request = { ...request, method: 'GET', body: null };
      }
      continue;
    }
    delete response.headers.location;
    return { ...response, url: target.toString() };
  }
  throw new Error('too many redirects');
}

async function assertCrawlableUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw Object.assign(new Error('Invalid URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
  if (parsed.username || parsed.password) throw Object.assign(new Error('Credentials in URL are not allowed'), { status: 400 });
  if (parsed.port && !ALLOWED_PORTS.includes(parsed.port)) throw Object.assign(new Error('Port not allowed'), { status: 400 });
  if (!(await hostAllowed(parsed.hostname))) throw Object.assign(new Error('Destination not allowed'), { status: 400 });
  return parsed.toString();
}

app.use((req, res, next) => {
  if (!SERVICE_TOKEN || req.path === '/health') return next();
  if (req.headers.authorization === `Bearer ${SERVICE_TOKEN}`) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
});

// Browser pool for reuse
let browser = null;
let browserPool = [];
let activeCrawls = 0;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

// Get a page from the browser pool
async function getPage() {
  await initBrowser();
  if (browserPool.length > 0) {
    return browserPool.pop();
  }
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    // Service-worker fetches bypass context.route, so they are not allowed.
    serviceWorkers: 'block',
  });
  // Every navigation, redirect and sub-resource is re-checked, so a public page cannot pull in internal URLs.
  await context.route('**/*', async (route) => {
    try {
      const target = new URL(route.request().url());
      if (target.protocol === 'data:' || target.protocol === 'blob:' || target.protocol === 'about:') return route.continue();
      // Fetched from Node against the validated address instead of route.continue(), which would let Chromium
      // resolve the name again (DNS rebinding).
      const request = route.request();
      const headersIn = await request.allHeaders();
      return await withRoutedSlot(async () => {
        const { status, headers, body } = await pinnedFetch(target.toString(), {
          method: request.method(),
          headers: headersIn,
          body: request.postDataBuffer(),
        });
        try {
          return await route.fulfill({ status, headers, body });
        } finally {
          releaseBytes(body.length);
        }
      });
    } catch {
      return route.abort('blockedbyclient');
    }
  });
  return await context.newPage();
}

// Return a page to the browser pool
async function returnPage(page) {
  if (browserPool.length < MAX_CONCURRENT) {
    await page.goto('about:blank');
    browserPool.push(page);
  } else {
    await page.context().close();
  }
}

// Crawl a single URL
async function crawlUrl(url, options = {}) {
  const timeout = options.timeout || TIMEOUT_MS;
  const waitFor = options.waitFor || 0;
  const screenshot = options.screenshot || false;
  const onlyMainContent = options.onlyMainContent !== false;
  const followRedirects = options.followRedirects !== false;

  const startTime = Date.now();
  let page = null;

  try {
    url = await assertCrawlableUrl(url);
    // Resolve redirects first (pinned and re-validated per hop) so the page loads at its final URL and relative
    // links resolve correctly.
    const resolved = await pinnedFetch(url, { method: 'GET', headers: { 'user-agent': USER_AGENT }, body: null, deadlineAt: startTime + timeout });
    releaseBytes(resolved.body.length);
    url = resolved.url;
    page = await getPage();

    // Set timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Crawl timeout')), timeout);
    });

    // Navigate to URL
    const response = await Promise.race([
      page.goto(url, {
        waitUntil: 'networkidle',
        timeout,
      }),
      timeoutPromise,
    ]);

    if (!response) {
      throw new Error('Failed to load page');
    }

    // Wait for additional content if specified
    if (waitFor > 0) {
      await page.waitForTimeout(waitFor);
    }

    // Extract content
    let content = '';
    let markdown = '';
    let title = '';

    title = await page.title();
    const html = await page.content();

    if (onlyMainContent) {
      // Try to extract main content using common selectors
      const mainSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.content',
        '#content',
        '.post-content',
        '.entry-content',
      ];

      let mainElement = null;
      for (const selector of mainSelectors) {
        try {
          mainElement = await page.locator(selector).first();
          if (await mainElement.count() > 0) {
            break;
          }
        } catch {
          continue;
        }
      }

      if (mainElement && await mainElement.count() > 0) {
        content = await mainElement.innerHTML();
      } else {
        content = html;
      }
    } else {
      content = html;
    }

    // Convert to markdown
    markdown = turndownService.turndown(content);

    // Take screenshot if requested
    let screenshotData = null;
    if (screenshot) {
      screenshotData = await page.screenshot({ encoding: 'base64' });
    }

    return {
      success: true,
      data: {
        url,
        title,
        content: content.slice(0, 500000), // Limit content size
        markdown: markdown.slice(0, 500000),
        statusCode: response.status(),
        screenshot: screenshotData,
        crawledAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url,
      duration: Date.now() - startTime,
    };
  } finally {
    if (page) {
      await returnPage(page);
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeCrawls,
    browserPoolSize: browserPool.length,
    timestamp: new Date().toISOString(),
  });
});

// Crawl endpoint
app.post('/crawl', async (req, res) => {
  const { url, timeout, waitFor, screenshot, onlyMainContent, followRedirects } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'URL is required',
    });
  }

  if (activeCrawls >= MAX_CONCURRENT) {
    return res.status(429).json({
      success: false,
      error: 'Too many concurrent crawls',
    });
  }

  activeCrawls++;

  try {
    const result = await crawlUrl(url, {
      timeout,
      waitFor,
      screenshot,
      onlyMainContent,
      followRedirects,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    activeCrawls--;
  }
});

// Batch crawl endpoint
app.post('/crawl/batch', async (req, res) => {
  const { urls, options } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'URLs array is required',
    });
  }

  const results = [];
  const CONCURRENCY = Math.min(MAX_CONCURRENT, urls.length);

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(url => crawlUrl(url, options))
    );
    results.push(...batchResults);
  }

  res.json({
    success: true,
    results,
    total: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Crawler service listening on port ${PORT}`);
  console.log(`Max concurrent crawls: ${MAX_CONCURRENT}`);
  console.log(`Default timeout: ${TIMEOUT_MS}ms`);
});
