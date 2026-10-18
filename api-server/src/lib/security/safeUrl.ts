/**
 * Outbound URL safety for any server-side fetch of a URL that came from outside the codebase
 * (web search results, provider records, notice attachments, user input).
 *
 * Protects against SSRF: non-HTTP schemes, embedded credentials, unusual ports, IP literals or DNS answers in
 * private / loopback / link-local / metadata / CGNAT / multicast ranges, and redirects that hop to any of these.
 * Every redirect hop is re-validated, so a public URL that 302s to http://169.254.169.254/ is refused.
 */
import { lookup } from "node:dns/promises";
import { lookup as lookupCallback, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_url"
      | "scheme"
      | "credentials"
      | "port"
      | "private_address"
      | "dns_failure"
      | "redirect_limit"
      | "too_large"
      | "content_type",
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion"];

function ipv4ToInt(address: string): number {
  return address
    .split(".")
    .reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function inIpv4Cidr(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  // IPv4-mapped tail, e.g. ::ffff:127.0.0.1
  const v4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[2]!);
    value = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group || "0", 16));
  return parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : parsed;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return PRIVATE_IPV4.some(([base, bits]) => inIpv4Cidr(address, base, bits));
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    if (groups.every((g) => g === 0)) return true; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
    // IPv4-mapped / IPv4-compatible / NAT64 well-known prefix: judge the embedded IPv4 address.
    const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
      return isPrivateAddress(embedded);
    }
    if (g0 === 0x64 && g1 === 0xff9b) return isPrivateAddress(embedded);
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
    if (g0 === 0x2002) {
      // 6to4 embeds an IPv4 address in groups 1-2.
      return isPrivateAddress(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`);
    }
    return false;
  }
  return true;
}

export interface UrlSafetyOptions {
  /** DNS resolver, injectable for tests. Returns every address the hostname resolves to. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Allow plain http (default true; many public procurement portals still serve http). */
  allowHttp?: boolean;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/** Validates a URL for server-side fetching. Throws UnsafeUrlError; returns the parsed URL when safe. */
export async function assertSafeExternalUrl(
  raw: string,
  options: UrlSafetyOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${String(raw).slice(0, 120)}`, "invalid_url");
  }
  const allowHttp = options.allowHttp ?? true;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UnsafeUrlError(`Blocked URL scheme ${url.protocol}`, "scheme");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not fetched", "credentials");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError(`Blocked URL port ${url.port}`, "port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new UnsafeUrlError("URL has no host", "invalid_url");
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeUrlError(`Blocked internal hostname ${hostname}`, "private_address");
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError(`Blocked private address ${hostname}`, "private_address");
    }
    return url;
  }
  // Numeric-looking hosts such as 2130706433 or 0x7f.1 are parsed by WHATWG URL into dotted IPv4, but guard anyway.
  if (/^[0-9.]+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    throw new UnsafeUrlError(`Blocked numeric host ${hostname}`, "private_address");
  }
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(hostname);
  } catch (error) {
    throw new UnsafeUrlError(
      `DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      "dns_failure",
    );
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`No DNS answer for ${hostname}`, "dns_failure");
  const blocked = addresses.find((address) => isPrivateAddress(address));
  if (blocked) {
    throw new UnsafeUrlError(`Host ${hostname} resolves to private address ${blocked}`, "private_address");
  }
  return url;
}

/** Synchronous pre-check (no DNS) for places that must stay synchronous, e.g. filtering a candidate list. */
export function isObviouslyUnsafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return true;
    if (url.username || url.password) return true;
    if (!ALLOWED_PORTS.has(url.port)) return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
    return Boolean(isIP(hostname) && isPrivateAddress(hostname));
  } catch {
    return true;
  }
}

export interface SafeFetchOptions extends UrlSafetyOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Allowed media types (prefix match, e.g. "application/pdf", "text/"). Empty or undefined allows any. */
  allowedContentTypes?: readonly string[];
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  headers: Headers;
  redirects: string[];
}

function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * DNS lookup used at connect time: refuses private answers, so a hostname that passed validation cannot be
 * re-pointed at an internal address between the check and the connection (DNS rebinding).
 */
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const rows = (Array.isArray(addresses) ? addresses : []) as LookupAddress[];
    const safe = rows.filter((row) => !isPrivateAddress(row.address));
    if (safe.length === 0 || safe.length !== rows.length) {
      return callback(
        Object.assign(new Error(`Refusing connection: ${hostname} resolved to a private address`), {
          code: "EUNSAFEADDRESS",
        }),
        "",
        0,
      );
    }
    if ((options as { all?: boolean }).all) return (callback as any)(null, safe);
    return callback(null, safe[0]!.address, safe[0]!.family);
  });
};

/** Minimal fetch over node:http(s) with the pinned lookup. Bodies are streamed; redirects are never followed here. */
const pinnedFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input));
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
        lookup: pinnedLookup,
        signal: init?.signal ?? undefined,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
          else if (value != null) headers.set(key, String(value));
        }
        const status = incoming.statusCode ?? 0;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status: status < 200 || status > 599 ? 502 : status, headers }));
      },
    );
    request.on("error", reject);
    request.end();
  });

/**
 * Fetches an untrusted URL with SSRF validation on every hop, a hard byte ceiling enforced while streaming
 * (not trusting Content-Length), a timeout, and an optional content-type allowlist. Never forwards cookies.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? pinnedFetch;
  const maxRedirects = options.maxRedirects ?? 4;
  const redirects: string[] = [];
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let current = (await assertSafeExternalUrl(raw, options)).toString();

  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "InsightHub-DocumentFetcher/1.0 (+procurement document retrieval)",
        Accept: "*/*",
        ...(options.headers ?? {}),
      },
      signal,
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) {
        throw new UnsafeUrlError(`Redirect limit (${maxRedirects}) exceeded`, "redirect_limit");
      }
      const next = new URL(response.headers.get("location")!, current).toString();
      current = (await assertSafeExternalUrl(next, options)).toString();
      redirects.push(current);
      continue;
    }

    const contentType = mediaType(response.headers.get("content-type"));
    if (
      response.ok &&
      options.allowedContentTypes?.length &&
      contentType &&
      !options.allowedContentTypes.some((allowed) => contentType.startsWith(allowed))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new UnsafeUrlError(`Content type ${contentType} is not allowed`, "content_type");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new UnsafeUrlError(`Response declares ${declared} bytes (limit ${options.maxBytes})`, "too_large");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new UnsafeUrlError(`Response exceeded ${options.maxBytes} bytes`, "too_large");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      finalUrl: current,
      status: response.status,
      contentType,
      bytes,
      headers: response.headers,
      redirects,
    };
  }
}
