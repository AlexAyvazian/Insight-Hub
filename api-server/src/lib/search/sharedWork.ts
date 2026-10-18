/**
 * Work shared across the discovery providers that run in parallel in one process.
 *
 * Several search providers often surface the same solicitation URL in the same ingestion run. Each provider used to
 * enrich and AI-extract it on its own, paying page-fetch credits and model requests per provider before the records
 * were merged. A page is now fetched once per canonical URL (concurrent callers wait for the fetch in flight, later
 * callers reuse the result within its TTL), and the AI extraction cache is keyed by the canonical URL and content
 * rather than by each provider's own title wording.
 */
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref|ref_src|srsltid)$/i;

/** Lower-case host, no fragment, no tracking parameters, sorted query, no trailing slash. */
export function canonicalCandidateUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, val] of kept) url.searchParams.append(key, val);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

interface Entry<T> {
  value: T;
  expires: number;
}

export class SharedWork<T> {
  private readonly done = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  hits = 0;
  joins = 0;
  runs = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    /** Only results that pass are cached; a miss is retried by the next caller. */
    private readonly keep: (value: T) => boolean,
  ) {}

  peek(key: string, now = Date.now()): T | undefined {
    const entry = this.done.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.done.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * The cached value, the result of the identical call already in flight, or a fresh run. A failed or discarded
   * shared run is not inherited: the waiter runs its own attempt.
   */
  async run(key: string, work: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.joins += 1;
      try {
        const value = await pending;
        if (this.keep(value)) return value;
      } catch {
        // fall through to an own attempt
      }
    }
    this.runs += 1;
    const promise = work();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      if (this.keep(value)) this.store(key, value);
      return value;
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  store(key: string, value: T): void {
    this.done.delete(key);
    this.done.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.done.size > this.maxEntries) {
      const oldest = this.done.keys().next().value as string | undefined;
      if (!oldest) break;
      this.done.delete(oldest);
    }
  }

  clear(): void {
    this.done.clear();
    this.inflight.clear();
    this.hits = 0;
    this.joins = 0;
    this.runs = 0;
  }
}
