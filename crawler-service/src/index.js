import express from 'express';
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

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

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2002:');
}

const hostVerdicts = new Map();
async function hostAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.test(host)) return false;
  if (net.isIP(host)) return !isPrivateAddress(host);
  const cached = hostVerdicts.get(host);
  if (cached && cached.expires > Date.now()) return cached.allowed;
  let allowed = false;
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    allowed = answers.length > 0 && answers.every((answer) => !isPrivateAddress(answer.address));
  } catch {
    allowed = false;
  }
  hostVerdicts.set(host, { allowed, expires: Date.now() + 60_000 });
  return allowed;
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
  if (parsed.port && !['80', '443', '8080', '8443'].includes(parsed.port)) throw Object.assign(new Error('Port not allowed'), { status: 400 });
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
  });
  // Every navigation, redirect and sub-resource is re-checked, so a public page cannot pull in internal URLs.
  await context.route('**/*', async (route) => {
    try {
      const target = new URL(route.request().url());
      if (target.protocol === 'data:' || target.protocol === 'blob:' || target.protocol === 'about:') return route.continue();
      if (!['http:', 'https:'].includes(target.protocol) || !(await hostAllowed(target.hostname))) return route.abort('blockedbyclient');
      return route.continue();
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
