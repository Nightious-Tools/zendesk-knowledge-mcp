import { loadConfig, type Config } from "../src/config.js";
import type { FetchLike } from "../src/util/http.js";

export interface Route { status?: number; body?: string; headers?: Record<string, string>; json?: unknown }
export type Routes = Record<string, Route | Route[] | ((url: string) => Route)>;

/** Deterministic fetch stub keyed by URL prefix (longest prefix wins). Arrays are consumed in order (for retry tests). */
export function mockFetch(routes: Routes): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const key = Object.keys(routes).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response("not found", { status: 404 });
    let r = routes[key];
    if (typeof r === "function") r = r(url);
    if (Array.isArray(r)) { r = r.length > 1 ? r.shift()! : r[0]; }
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? "");
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": r.json !== undefined ? "application/json" : "text/html", ...(r.headers ?? {}) } });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({}), maxRetries: 2, timeoutMs: 500, logLevel: "silent", cacheTtlS: { search: 60, page: 60, status: 60, sitemap: 60 }, ...over };
}

export const article = (over: Record<string, unknown> = {}) => ({
  id: 4408893545882,
  html_url: "https://support.zendesk.com/hc/en-us/articles/4408893545882-Ticket-trigger-conditions",
  title: "Ticket trigger conditions and actions reference",
  locale: "en-us",
  section_id: 5634465167514,
  created_at: "2021-10-16T17:09:19Z",
  updated_at: "2026-06-24T09:51:25Z",
  edited_at: "2026-05-06T18:58:36Z",
  label_names: ["trigger", "support"],
  draft: false,
  body: `<p id="docs-hc-snippet" style="display:none">hidden</p>
<div class="article-banners"><div id="docs-wmp-link"><a href="#">What's my plan?</a></div>
<div class="article-banner" id="suite_all"><table><tr><td><strong>All Suites</strong></td><td>Team, Growth, Professional, Enterprise, or Enterprise Plus</td></tr></table></div>
<div class="article-banner" id="support_all"><table><tr><td><strong>Support</strong></td><td>Team, Professional, or Enterprise</td></tr></table></div></div>
<div id="docs-ai-summary"><p id="docs-ai-summary-toggle">Summary:</p><p id="docs-ai-summary-content">Triggers run when tickets are created or updated.</p></div>
<h2>Conditions</h2><p>Use <strong>conditions</strong> to decide when a trigger fires.</p><ul><li>Status</li><li>Priority</li></ul>
<pre>{"trigger": true}</pre>`,
  ...over,
});
