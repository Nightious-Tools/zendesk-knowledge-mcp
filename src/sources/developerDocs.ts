import * as cheerio from "cheerio";
import { OFFICIAL_HOSTS, type Config } from "../config.js";
import type { HttpClient } from "../util/http.js";
import { htmlToText, snippetAround, truncate } from "../util/html.js";
import { classifyLifecycle, detectProducts } from "../util/classify.js";
import { ZdError } from "../util/errors.js";
import type { DocResult, Source } from "../types.js";

const BASE = `https://${OFFICIAL_HOSTS.developer}`;
const SITEMAP_INDEX = `${BASE}/sitemap-index.xml`;

interface IndexEntry { url: string; tokens: string[]; path: string }

/**
 * developer.zendesk.com has no public search API, so we build a *URL-only*
 * index from its official sitemap (a few hundred KB, cached for one hour),
 * rank by slug tokens, then fetch only the top pages live for snippets.
 * No page bodies are stored beyond the short page cache.
 */
export class DeveloperDocsSource {
  private index: { entries: IndexEntry[]; loadedAt: number; retrievedAt: string } | null = null;

  constructor(private http: HttpClient, private cfg: Config) {}
  private ttl(kind: keyof Config["cacheTtlS"]) { return this.cfg.cacheTtlS[kind] * 1000; }

  async loadIndex(): Promise<IndexEntry[]> {
    if (this.index && Date.now() - this.index.loadedAt < this.ttl("sitemap")) return this.index.entries;
    const idx = await this.http.get(SITEMAP_INDEX, { ttlMs: this.ttl("sitemap"), accept: "text/xml,application/xml" });
    const sitemaps = [...idx.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => u.startsWith(BASE));
    const urls = new Set<string>();
    for (const sm of sitemaps.slice(0, 10)) {
      const r = await this.http.get(sm, { ttlMs: this.ttl("sitemap"), accept: "text/xml,application/xml" });
      for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) if (m[1].startsWith(BASE)) urls.add(m[1]);
    }
    if (!sitemaps.length) {
      // sitemap-index may itself be a urlset
      for (const m of idx.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) if (m[1].startsWith(BASE)) urls.add(m[1]);
    }
    const entries: IndexEntry[] = [...urls].map((url) => {
      const path = new URL(url).pathname;
      return { url, path, tokens: tokenize(path) };
    });
    this.index = { entries, loadedAt: Date.now(), retrievedAt: idx.retrievedAt };
    return entries;
  }

  /** Rank sitemap entries, then fetch the top N for title/snippet/lifecycle. */
  async search(query: string, opts: { maxResults?: number; fetchPages?: boolean; section?: "api-reference" | "documentation" | "any" } = {}): Promise<{ results: DocResult[]; notes: string[]; candidates: string[] }> {
    const max = Math.min(Math.max(opts.maxResults ?? 5, 1), 10);
    const entries = await this.loadIndex();
    const qTokens = tokenize(query);
    const notes: string[] = [];
    if (!qTokens.length) throw new ZdError("Query is empty after normalisation", "BAD_INPUT");
    const scored = entries
      .filter((e) => opts.section && opts.section !== "any" ? e.path.startsWith(`/${opts.section}/`) : true)
      .map((e) => ({ e, s: rankEntry(qTokens, e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.e.path.length - b.e.path.length);
    const top = scored.slice(0, max);
    const candidates = scored.slice(0, 25).map((x) => x.e.url);
    if (!top.length) {
      notes.push("No developer.zendesk.com pages matched the query by URL slug. Try product/endpoint names as they appear in URLs (e.g. 'tickets', 'webhooks', 'custom objects').");
      return { results: [], notes, candidates };
    }
    if (opts.fetchPages === false) {
      return { results: top.map((x) => this.stubResult(x.e.url, this.index!.retrievedAt)), notes: [...notes, "Pages not fetched (fetchPages=false); titles derived from URLs."], candidates };
    }
    const settled = await Promise.allSettled(top.map((x) => this.getPage(x.e.url, { snippetFor: query })));
    const results: DocResult[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.push(r.value);
      else { notes.push(`Could not fetch ${top[i].e.url}: ${(r.reason as Error).message}`); results.push(this.stubResult(top[i].e.url, this.index!.retrievedAt)); }
    });
    return { results, notes, candidates };
  }

  /** Fetch and clean a developer.zendesk.com page. */
  async getPage(url: string, o: { snippetFor?: string } = {}): Promise<DocResult> {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== OFFICIAL_HOSTS.developer) throw new ZdError(`Only ${OFFICIAL_HOSTS.developer} URLs are accepted (got ${u.hostname})`, "DOMAIN_NOT_ALLOWED");
    u.hash = ""; u.search = "";
    const canonical = u.toString().endsWith("/") ? u.toString() : u.toString() + "/";
    const r = await this.http.get(canonical, { ttlMs: this.ttl("page") });
    const $ = cheerio.load(r.body);
    const title = ($("main h1").first().text() || $("h1").first().text() || $("title").text().replace(/\s*\|.*$/, "")).replace(/\s+/g, " ").trim();
    const main = $("main").length ? $("main") : $("body");
    // remove breadcrumbs, sidebars, "On this page" nav, footer blocks
    main.find("nav, aside, [class*='Breadcrumb'], [class*='breadcrumb'], [class*='TableOfContents'], [class*='tableOfContents'], [class*='Footer'], [class*='footer'], [class*='Sidebar'], [class*='sidebar']").remove();
    const cleaned = htmlToText(main.html() ?? "", canonical);
    // Zendesk marks deprecated endpoints with a tag/badge; capture visible badges near the title.
    const badges = main.find("[class*='Tag'], [class*='tag'], [class*='Badge'], [class*='badge']").map((_, el) => $(el).text().trim()).get().filter((t) => t && t.length < 40);
    const breadcrumbs = u.pathname.split("/").filter(Boolean).slice(0, -1).map(humanize);
    const lastMod = $("meta[property='article:modified_time']").attr("content") || $("time[datetime]").first().attr("datetime") || undefined;
    const lifecycle = classifyLifecycle({ title, text: cleaned.text, labels: badges, breadcrumbs });
    const body = o.snippetFor ? { text: snippetAround(cleaned.text, o.snippetFor, 500), truncated: true } : truncate(cleaned.text, this.cfg.maxContentChars);
    const source: Source = { kind: "developer_docs", url: canonical, title, retrieved_at: r.retrievedAt, from_cache: r.cached };
    return {
      title,
      url: canonical,
      content: body.text,
      content_truncated: body.truncated,
      updated_at: lastMod,
      effective_date: lifecycle.effective_date,
      product: detectProducts(title, badges, breadcrumbs),
      plan_requirements: cleaned.plan_requirements,
      lifecycle,
      breadcrumbs,
      labels: badges.length ? [...new Set(badges)] : undefined,
      authority: "canonical",
      source,
    };
  }

  private stubResult(url: string, retrievedAt: string): DocResult {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const title = humanize(parts[parts.length - 1] ?? "");
    return {
      title, url, content: "", content_truncated: true,
      plan_requirements: [],
      lifecycle: { status: "unknown", confidence: "low", scope: "whole", evidence: ["page not fetched"] },
      breadcrumbs: parts.slice(0, -1).map(humanize),
      authority: "canonical",
      source: { kind: "developer_docs", url, title, retrieved_at: retrievedAt, from_cache: true },
    };
  }
}

const SYNONYMS: Record<string, string[]> = {
  ticket: ["tickets", "ticketing"], tickets: ["ticket", "ticketing"],
  user: ["users"], users: ["user"], org: ["organizations", "organization"], organization: ["organizations"],
  webhook: ["webhooks"], webhooks: ["webhook"], trigger: ["triggers"], triggers: ["trigger"],
  automation: ["automations"], macro: ["macros"], view: ["views"], article: ["articles"], articles: ["article"],
  hc: ["help-center", "help_center"], "help": ["help-center"], guide: ["help-center"],
  auth: ["oauth", "authentication"], oauth: ["oauth"], token: ["tokens"], app: ["apps"], apps: ["app"],
  "custom": ["custom-objects", "custom-data"], object: ["objects", "custom-objects"], objects: ["object"],
  incremental: ["incremental-export"], export: ["incremental-export", "exports"], search: ["search"],
  rate: ["rate-limits"], limit: ["rate-limits", "limits"], limits: ["rate-limits"],
  sunshine: ["sunshine-conversations", "conversations"], sunco: ["sunshine-conversations"], messaging: ["messaging", "conversations"],
  zaf: ["apps", "apps-framework"], sdk: ["sdks", "sdk"], "side": ["side_conversations"], conversation: ["conversations", "side_conversations"],
};

export function tokenize(s: string): string[] {
  const toks = s.toLowerCase().replace(/\.[a-z]+$/, "").split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const set = new Set(toks);
  for (const t of toks) for (const syn of SYNONYMS[t] ?? []) set.add(syn);
  return [...set];
}

function rankEntry(q: string[], e: IndexEntry): number {
  let s = 0;
  const pathStr = e.path;
  const slug = pathStr.split("/").filter(Boolean).pop() ?? "";
  for (const t of q) {
    if (e.tokens.includes(t)) s += 2;
    else if (e.tokens.some((k) => k.includes(t) || t.includes(k))) s += 0.5;
    if (slug.includes(t)) s += 1.5;
  }
  if (pathStr.startsWith("/api-reference/")) s += 0.3;
  if (/introduction|index/.test(slug)) s += 0.2;
  return s;
}

function humanize(seg: string): string {
  return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
