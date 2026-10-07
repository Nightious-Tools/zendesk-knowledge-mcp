import * as cheerio from "cheerio";
import { OFFICIAL_HOSTS, type Config } from "../config.js";
import type { HttpClient } from "../util/http.js";
import { htmlToText, snippetAround, truncate } from "../util/html.js";
import { classifyLifecycle, detectProducts, scoreText } from "../util/classify.js";
import { NotFoundError, ZdError } from "../util/errors.js";
import type { DocResult, Source } from "../types.js";

const BASE = `https://${OFFICIAL_HOSTS.support}`;

/** Minimal shape of a Help Center article (search hit or show). */
export interface HcArticle {
  id: number;
  html_url: string;
  title: string;
  body?: string;
  snippet?: string;
  locale: string;
  section_id?: number;
  created_at: string;
  updated_at: string;
  edited_at?: string;
  label_names?: string[];
  draft?: boolean;
  outdated?: boolean;
}
interface HcSearchResponse {
  results: HcArticle[];
  count: number;
  page: number;
  page_count: number;
  per_page: number;
  next_page: string | null;
}
interface HcSection { id: number; name: string; category_id: number }
interface HcCategory { id: number; name: string }

/** Sections/categories inside the "Zendesk updates" category. Discovered live; these are fallbacks only. */
export const KNOWN_UPDATE_IDS = {
  updatesCategory: 4405298749210,
  announcements: 4405298833818,
  developerUpdates: 4405298889242,
  releaseNotes: 4405298847002,
  whatsNew: 4405298877338,
};

export interface SearchOpts {
  query: string;
  locale?: string;
  product?: string;
  page?: number;
  perPage?: number;
  categoryId?: number;
  sectionId?: number;
  createdAfter?: string;   // yyyy-mm-dd
  updatedAfter?: string;
  sortBy?: "created_at" | "updated_at";
}

export class HelpCenterSource {
  private sectionCache: Map<number, HcSection> = new Map();
  private categoryCache: Map<number, HcCategory> = new Map();
  private taxonomyLoaded = 0;

  constructor(private http: HttpClient, private cfg: Config) {}

  private ttl(kind: keyof Config["cacheTtlS"]) { return this.cfg.cacheTtlS[kind] * 1000; }

  /** Official Help Center Search API (articles only — never community posts). */
  async search(opts: SearchOpts): Promise<{ results: DocResult[]; pagination: NonNullable<import("../types.js").ToolEnvelope<unknown>["pagination"]>; notes: string[] }> {
    const locale = (opts.locale ?? this.cfg.defaultLocale).toLowerCase();
    const perPage = Math.min(Math.max(opts.perPage ?? 10, 1), 30);
    const page = Math.max(opts.page ?? 1, 1);
    const q = new URLSearchParams({ query: opts.query.trim(), locale, per_page: String(perPage), page: String(page) });
    if (opts.categoryId) q.set("category", String(opts.categoryId));
    if (opts.sectionId) q.set("section", String(opts.sectionId));
    if (opts.createdAfter) q.set("created_after", opts.createdAfter);
    if (opts.updatedAfter) q.set("updated_after", opts.updatedAfter);
    if (opts.sortBy) { q.set("sort_by", opts.sortBy); q.set("sort_order", "desc"); }
    const url = `${BASE}/api/v2/help_center/articles/search.json?${q}`;
    const { data, meta } = await this.http.getJson<HcSearchResponse>(url, this.ttl("search"));
    await this.ensureTaxonomy(locale);

    const notes: string[] = [];
    let hits = (data.results ?? []).filter((a) => !a.draft);
    // Soft product filter: keep everything but rank product matches first; report if nothing matched.
    const product = opts.product?.trim().toLowerCase();
    let results = hits.map((a) => this.toResult(a, opts.query, meta.retrievedAt, meta.cached, { snippet: true }));
    if (product) {
      const matches = (r: DocResult) => (r.product ?? []).some((p) => p.toLowerCase().includes(product)) || r.title.toLowerCase().includes(product) || (r.labels ?? []).some((l) => l.toLowerCase().includes(product));
      const matched = results.filter(matches);
      if (matched.length) results = [...matched, ...results.filter((r) => !matches(r))];
      else notes.push(`No results on this page were tagged with product "${opts.product}"; showing unfiltered results.`);
    }
    results.sort((a, b) => (product ? 0 : scoreText(opts.query, b.title, b.content) - scoreText(opts.query, a.title, a.content)) || 0);
    if (data.count === 0) notes.push("The Zendesk Help Center search returned no articles for this query. Try fewer/other keywords or a different locale.");
    return {
      results,
      pagination: { page: data.page, per_page: data.per_page, page_count: data.page_count, total: data.count, next_page: data.next_page ? data.page + 1 : null },
      notes,
    };
  }

  /** Fetch one article by numeric id or any support.zendesk.com article URL. */
  async getArticle(idOrUrl: string, locale?: string): Promise<DocResult> {
    const { id, locale: urlLocale } = parseArticleRef(idOrUrl);
    const loc = (locale ?? urlLocale ?? this.cfg.defaultLocale).toLowerCase();
    const url = `${BASE}/api/v2/help_center/${encodeURIComponent(loc)}/articles/${id}.json`;
    let data: { article: HcArticle };
    let meta;
    try {
      ({ data, meta } = await this.http.getJson<{ article: HcArticle }>(url, this.ttl("page")));
    } catch (e) {
      const st = (e as any)?.status as number | undefined;
      if (st === 404) throw new NotFoundError(`Article ${id} in locale ${loc}`);
      if (st === 401 || st === 403) throw new ZdError(`Article ${id} is restricted by Zendesk (requires a signed-in user segment); it cannot be read anonymously. Cite ${BASE}/hc/${loc}/articles/${id} and ask the user to open it while signed in.`, "RESTRICTED", { id, locale: loc, status: st });
      throw e;
    }
    await this.ensureTaxonomy(loc);
    return this.toResult(data.article, "", meta.retrievedAt, meta.cached, { snippet: false });
  }

  /** List articles in a section/category (used for change feeds without a query). */
  async listArticles(scope: { sectionId?: number; categoryId?: number }, locale: string, perPage = 30, page = 1): Promise<{ articles: HcArticle[]; retrievedAt: string; cached: boolean; nextPage: boolean }> {
    const path = scope.sectionId ? `sections/${scope.sectionId}` : `categories/${scope.categoryId}`;
    const url = `${BASE}/api/v2/help_center/${encodeURIComponent(locale)}/${path}/articles.json?sort_by=created_at&sort_order=desc&per_page=${perPage}&page=${page}`;
    const { data, meta } = await this.http.getJson<{ articles: HcArticle[]; next_page: string | null }>(url, this.ttl("search"));
    return { articles: data.articles ?? [], retrievedAt: meta.retrievedAt, cached: meta.cached, nextPage: !!data.next_page };
  }

  /** Resolve the live ids of the "Zendesk updates" category and its sections by name, falling back to known ids. */
  async resolveUpdateScopes(locale: string): Promise<{ categoryId: number; sections: Record<"announcements" | "developerUpdates" | "releaseNotes" | "whatsNew", number | undefined> }> {
    await this.ensureTaxonomy(locale);
    const byName = (re: RegExp, m: Map<number, { id: number; name: string }>) => [...m.values()].find((x) => re.test(x.name))?.id;
    const categoryId = byName(/^zendesk updates$/i, this.categoryCache) ?? KNOWN_UPDATE_IDS.updatesCategory;
    const sec = (re: RegExp, fb: number) => {
      const s = [...this.sectionCache.values()].find((x) => re.test(x.name) && x.category_id === categoryId);
      return s?.id ?? fb;
    };
    return {
      categoryId,
      sections: {
        announcements: sec(/^announcements$/i, KNOWN_UPDATE_IDS.announcements),
        developerUpdates: sec(/^developer updates$/i, KNOWN_UPDATE_IDS.developerUpdates),
        releaseNotes: sec(/^release notes$/i, KNOWN_UPDATE_IDS.releaseNotes),
        whatsNew: sec(/what'?s new/i, KNOWN_UPDATE_IDS.whatsNew),
      },
    };
  }

  breadcrumbsFor(sectionId?: number): string[] {
    if (!sectionId) return [];
    const s = this.sectionCache.get(sectionId);
    if (!s) return [];
    const c = this.categoryCache.get(s.category_id);
    return [c?.name, s.name].filter(Boolean) as string[];
  }

  /** Load sections & categories once per TTL window (they're small and change rarely). */
  private async ensureTaxonomy(locale: string): Promise<void> {
    if (Date.now() - this.taxonomyLoaded < this.ttl("sitemap")) return;
    try {
      for (let page = 1; page <= 10; page++) {
        const { data } = await this.http.getJson<{ sections: HcSection[]; next_page: string | null }>(
          `${BASE}/api/v2/help_center/${encodeURIComponent(locale)}/sections.json?per_page=100&page=${page}`, this.ttl("sitemap"));
        for (const s of data.sections ?? []) this.sectionCache.set(s.id, s);
        if (!data.next_page) break;
      }
      const { data: cats } = await this.http.getJson<{ categories: HcCategory[] }>(
        `${BASE}/api/v2/help_center/${encodeURIComponent(locale)}/categories.json?per_page=100`, this.ttl("sitemap"));
      for (const c of cats.categories ?? []) this.categoryCache.set(c.id, c);
      this.taxonomyLoaded = Date.now();
    } catch {
      // taxonomy is an enrichment only; never fail the main request because of it
      this.taxonomyLoaded = Date.now() - this.ttl("sitemap") + 60_000; // retry in a minute
    }
  }

  toResult(a: HcArticle, query: string, retrievedAt: string, cached: boolean, o: { snippet: boolean }): DocResult {
    const breadcrumbs = this.breadcrumbsFor(a.section_id);
    const cleaned = htmlToText(a.body ?? "", a.html_url);
    const full = cleaned.text;
    const body = o.snippet
      ? (a.snippet ? stripEm(a.snippet) : snippetAround(full, query))
      : truncate(full, this.cfg.maxContentChars);
    const kind = sourceKind(breadcrumbs);
    const lifecycle = classifyLifecycle({ title: a.title, text: full || (a.snippet ?? ""), labels: a.label_names, breadcrumbs, compilation: kind === "release_notes" || kind === "whats_new" });
    const source: Source = { kind, url: a.html_url, title: a.title, retrieved_at: retrievedAt, from_cache: cached };
    return {
      title: a.title,
      url: a.html_url,
      content: typeof body === "string" ? body : body.text,
      content_truncated: typeof body === "string" ? o.snippet : body.truncated,
      summary: cleaned.summary,
      updated_at: a.edited_at ?? a.updated_at,
      created_at: a.created_at,
      effective_date: lifecycle.effective_date,
      product: detectProducts(a.title, a.label_names, breadcrumbs, cleaned.plan_requirements.map((p) => p.product)),
      plan_requirements: cleaned.plan_requirements,
      lifecycle,
      locale: a.locale,
      breadcrumbs,
      labels: a.label_names,
      authority: kind === "help_center" ? "canonical" : kind === "release_notes" || kind === "whats_new" ? "changelog" : "announcement",
      source,
    };
  }
}

function sourceKind(breadcrumbs: string[]): Source["kind"] {
  const s = breadcrumbs.join(" > ").toLowerCase();
  if (/developer updates/.test(s)) return "developer_update";
  if (/release notes/.test(s)) return "release_notes";
  if (/what's new|whats new/.test(s)) return "whats_new";
  if (/announcements/.test(s)) return "announcement";
  return "help_center";
}

function stripEm(s: string): string {
  return cheerio.load(`<div>${s}</div>`)("div").text().replace(/\s+/g, " ").trim();
}

/** Accepts "4408893545882", "https://support.zendesk.com/hc/en-us/articles/4408893545882-Title", or ".../articles/4408893545882.json". */
export function parseArticleRef(ref: string): { id: number; locale?: string } {
  const t = ref.trim();
  if (/^\d{5,}$/.test(t)) return { id: Number(t) };
  let u: URL;
  try { u = new URL(t); } catch { throw new ZdError(`Not an article id or URL: ${ref}`, "BAD_INPUT"); }
  if (u.hostname.toLowerCase() !== OFFICIAL_HOSTS.support) throw new ZdError(`Only ${OFFICIAL_HOSTS.support} article URLs are accepted (got ${u.hostname})`, "DOMAIN_NOT_ALLOWED");
  const m = /\/articles\/(\d+)/.exec(u.pathname);
  if (!m) throw new ZdError(`URL does not point to a Help Center article: ${ref}`, "BAD_INPUT");
  const loc = /\/hc\/([a-z]{2}(?:-[a-z0-9]+)?)\//i.exec(u.pathname)?.[1] ?? /\/help_center\/([a-z]{2}(?:-[a-z0-9]+)?)\//i.exec(u.pathname)?.[1];
  return { id: Number(m[1]), locale: loc?.toLowerCase() };
}
