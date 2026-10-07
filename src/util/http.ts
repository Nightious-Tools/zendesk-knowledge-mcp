import { OFFICIAL_HOSTS, type Config } from "../config.js";
import { TtlCache } from "./cache.js";
import { RateLimiter } from "./rateLimiter.js";
import { DomainNotAllowedError, HttpError, TimeoutError } from "./errors.js";
import { Logger } from "./log.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchResult {
  url: string;          // final URL after redirects
  status: number;
  body: string;
  contentType: string;
  cached: boolean;
  retrievedAt: string;  // ISO timestamp of the live fetch that produced this body
}

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(Object.values(OFFICIAL_HOSTS));

/** True only for https URLs on the official Zendesk hosts this server trusts. */
export function isOfficialUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function assertOfficial(url: string): URL {
  if (!isOfficialUrl(url)) throw new DomainNotAllowedError(url);
  return new URL(url);
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Allow-listed HTTP client with timeout, bounded retries (honouring Retry-After),
 * per-host rate limiting, manual redirect validation, and short-lived caching.
 */
export class HttpClient {
  private cache: TtlCache<FetchResult>;
  private limiter: RateLimiter;
  private inflight = new Map<string, Promise<FetchResult>>();

  constructor(
    private cfg: Config,
    private log: Logger = new Logger(cfg.logLevel),
    private fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.cache = new TtlCache<FetchResult>(cfg.cacheMaxEntries);
    this.limiter = new RateLimiter(cfg.ratePerMin);
  }

  /** GET with caching. `ttlMs` = 0 disables caching for this call. */
  async get(url: string, opts: { ttlMs: number; accept?: string } = { ttlMs: 0 }): Promise<FetchResult> {
    assertOfficial(url);
    const key = `${opts.accept ?? "*"}|${url}`;
    const hit = opts.ttlMs > 0 ? this.cache.get(key) : undefined;
    if (hit) return { ...hit, cached: true };
    // de-duplicate concurrent identical requests
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.fetchWithRetry(url, opts.accept).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    const res = await p;
    if (opts.ttlMs > 0 && res.status === 200) this.cache.set(key, res, opts.ttlMs);
    return res;
  }

  async getJson<T>(url: string, ttlMs: number): Promise<{ data: T; meta: FetchResult }> {
    const r = await this.get(url, { ttlMs, accept: "application/json" });
    try {
      return { data: JSON.parse(r.body) as T, meta: r };
    } catch {
      throw new HttpError(r.status, `${url} (invalid JSON body)`);
    }
  }

  clearCache(): void { this.cache.clear(); }

  private async fetchWithRetry(url: string, accept?: string): Promise<FetchResult> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.cfg.maxRetries) {
      try {
        return await this.fetchOnce(url, accept);
      } catch (e) {
        lastErr = e;
        const retryable =
          e instanceof TimeoutError ||
          (e instanceof HttpError && RETRYABLE.has(e.status)) ||
          (!(e instanceof HttpError) && !(e instanceof DomainNotAllowedError));
        if (!retryable || attempt === this.cfg.maxRetries) break;
        const base = Math.min(8000, 400 * 2 ** attempt);
        const jitter = Math.floor(Math.random() * 250);
        const wait = e instanceof HttpError && e.retryAfterMs ? Math.min(30_000, e.retryAfterMs) : base + jitter;
        this.log.debug("retrying", { url, attempt, wait, reason: String(e) });
        await this.sleep(wait);
        attempt++;
      }
    }
    throw lastErr;
  }

  private async fetchOnce(url: string, accept?: string, hops = 0): Promise<FetchResult> {
    const u = assertOfficial(url);
    await this.limiter.acquire(u.hostname);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    const started = new Date().toISOString();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: {
          "User-Agent": this.cfg.userAgent,
          Accept: accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en",
        },
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw new TimeoutError(url, this.cfg.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hops >= 5) throw new HttpError(res.status, url);
      const next = new URL(loc, url).toString();
      assertOfficial(next); // redirect must also land on an official host
      return this.fetchOnce(next, accept, hops + 1);
    }
    if (res.status !== 200) {
      const ra = res.headers.get("retry-after");
      const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : undefined;
      let snippet: string | undefined;
      try { snippet = (await res.text()).replace(/\s+/g, " ").slice(0, 200) || undefined; } catch { /* ignore */ }
      throw new HttpError(res.status, url, retryAfterMs, res.status < 500 ? snippet : undefined);
    }
    const body = await res.text();
    return {
      url,
      status: res.status,
      body,
      contentType: res.headers.get("content-type") ?? "",
      cached: false,
      retrievedAt: started,
    };
  }
}
