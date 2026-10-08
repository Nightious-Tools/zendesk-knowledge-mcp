/** Runtime configuration, read from environment variables (see .env.example). */

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric env var ${name}=${v}`);
  return n;
}

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface Config {
  userAgent: string;
  defaultLocale: string;
  timeoutMs: number;
  maxRetries: number;
  ratePerMin: Record<string, number>;
  cacheTtlS: { search: number; page: number; status: number; sitemap: number };
  cacheMaxEntries: number;
  maxContentChars: number;
  logLevel: LogLevel;
}

export const OFFICIAL_HOSTS = {
  support: "support.zendesk.com",
  developer: "developer.zendesk.com",
  status: "status.zendesk.com",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const lvl = (env.ZD_LOG_LEVEL ?? "info") as LogLevel;
  return {
    userAgent: env.ZD_USER_AGENT ?? "zendesk-knowledge-mcp/1.0 (+https://github.com/Nightious-Tools/zendesk-knowledge-mcp)",
    defaultLocale: (env.ZD_DEFAULT_LOCALE ?? "en-us").toLowerCase(),
    timeoutMs: int("ZD_HTTP_TIMEOUT_MS", 15000),
    maxRetries: int("ZD_HTTP_MAX_RETRIES", 2),
    ratePerMin: {
      [OFFICIAL_HOSTS.support]: int("ZD_RATE_SUPPORT_PER_MIN", 60),
      [OFFICIAL_HOSTS.developer]: int("ZD_RATE_DEVELOPER_PER_MIN", 60),
      // Documented Zendesk limit for the Status API is 10 requests/minute.
      [OFFICIAL_HOSTS.status]: Math.min(10, int("ZD_RATE_STATUS_PER_MIN", 10)),
    },
    cacheTtlS: {
      search: int("ZD_CACHE_TTL_SEARCH_S", 300),
      page: int("ZD_CACHE_TTL_PAGE_S", 900),
      status: int("ZD_CACHE_TTL_STATUS_S", 60),
      sitemap: int("ZD_CACHE_TTL_SITEMAP_S", 3600),
    },
    cacheMaxEntries: int("ZD_CACHE_MAX_ENTRIES", 500),
    maxContentChars: int("ZD_MAX_CONTENT_CHARS", 12000),
    logLevel: ["silent", "error", "info", "debug"].includes(lvl) ? lvl : "info",
  };
}
