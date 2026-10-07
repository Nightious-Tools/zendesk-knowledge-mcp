import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { HttpClient, type FetchLike } from "./util/http.js";
import { Logger } from "./util/log.js";
import { ZdError } from "./util/errors.js";
import { detectConflicts, scoreText } from "./util/classify.js";
import { HelpCenterSource } from "./sources/helpCenter.js";
import { DeveloperDocsSource } from "./sources/developerDocs.js";
import { ChangesSource } from "./sources/changes.js";
import { StatusSource } from "./sources/status.js";
import type { DocResult, Source, ToolEnvelope, ToolFailure } from "./types.js";

export const SERVER_NAME = "zendesk-knowledge";
export const SERVER_VERSION = "1.0.0";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export interface Deps { cfg?: Config; fetchImpl?: FetchLike; logger?: Logger }

/** Build the MCP server. Dependencies are injectable so tests can stub the network. */
export function createServer(deps: Deps = {}): { server: McpServer; http: HttpClient; cfg: Config } {
  const cfg = deps.cfg ?? loadConfig();
  const log = deps.logger ?? new Logger(cfg.logLevel);
  const http = new HttpClient(cfg, log, deps.fetchImpl);
  const hc = new HelpCenterSource(http, cfg);
  const dev = new DeveloperDocsSource(http, cfg);
  const changes = new ChangesSource(http, cfg, hc);
  const status = new StatusSource(http, cfg);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "Read-only Zendesk documentation expert. Every tool fetches live from official Zendesk sources only",
        "(support.zendesk.com, developer.zendesk.com, status.zendesk.com). Always cite the `citations` URLs in answers.",
        "Treat `lifecycle.status` carefully: 'current' = documented GA behaviour; 'future' = announced but not yet in effect;",
        "'beta'/'eap' = limited availability; 'deprecated'/'legacy' = still works but superseded; 'retired' = gone.",
        "Prefer canonical docs (authority=canonical) for current behaviour, changelogs/release notes for what changed and when.",
        "If `conflicts` is present, tell the user which source was preferred and why. Never present community content as authoritative.",
        "This server cannot modify any Zendesk account.",
      ].join(" "),
    },
  );

  const ok = <T>(tool: string, data: T, citations: Source[], notes: string[] = [], extra: Partial<ToolEnvelope<T>> = {}): ToolEnvelope<T> =>
    ({ ok: true, tool, retrieved_at: new Date().toISOString(), data, citations: dedupe(citations), notes, ...extra });

  const respond = (payload: ToolEnvelope<unknown> | ToolFailure) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: !payload.ok,
  });

  const guard = async (tool: string, fn: () => Promise<ToolEnvelope<unknown>>) => {
    try {
      const r = await fn();
      log.info("tool ok", { tool, citations: r.citations.length });
      return respond(r);
    } catch (e) {
      const err = e instanceof ZdError ? { code: e.code, message: e.message, details: e.details } : { code: "INTERNAL", message: (e as Error)?.message ?? String(e) };
      log.error("tool failed", { tool, ...err });
      return respond({ ok: false, tool, error: err });
    }
  };

  const citationsOf = (docs: DocResult[]): Source[] => docs.map((d) => d.source);

  /* ------------------------------------------------------------- tools */

  server.registerTool(
    "search_help_center",
    {
      title: "Search Zendesk Help Center",
      description:
        "Search official Zendesk product documentation on support.zendesk.com via the Help Center Search API (articles only; community posts are excluded). " +
        "Returns title, snippet, canonical URL, updated date, product, plan requirements and lifecycle status for each hit. Paginated.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Keywords, e.g. 'trigger conditions' or 'SLA policies'"),
        locale: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)?$/i).optional().describe("Help Center locale, default en-us"),
        product: z.string().max(60).optional().describe("Soft filter/boost, e.g. Support, Guide, Messaging, Talk, Explore, Sell, AI agents, Admin Center"),
        page: z.number().int().min(1).max(100).optional().describe("Result page (default 1)"),
        per_page: z.number().int().min(1).max(30).optional().describe("Results per page (default 10, max 30)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => guard("search_help_center", async () => {
      const r = await hc.search({ query: a.query, locale: a.locale, product: a.product, page: a.page, perPage: a.per_page });
      return ok("search_help_center", { results: r.results }, citationsOf(r.results), r.notes, { pagination: r.pagination, conflicts: orUndefined(detectConflicts(r.results)) });
    }),
  );

  server.registerTool(
    "get_help_article",
    {
      title: "Get Zendesk Help Center article",
      description: "Fetch one official Help Center article by numeric id or support.zendesk.com URL. Returns cleaned full text (truncated if very long), plan banners, breadcrumbs, dates and lifecycle classification.",
      inputSchema: {
        article_id_or_url: z.string().min(1).describe("e.g. 4408893545882 or https://support.zendesk.com/hc/en-us/articles/4408893545882-..."),
        locale: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)?$/i).optional().describe("Override locale (defaults to the URL's locale or en-us)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => guard("get_help_article", async () => {
      const doc = await hc.getArticle(a.article_id_or_url, a.locale);
      const notes: string[] = [];
      if (doc.lifecycle.future_change_mentioned) notes.push(`Article references a future-dated change: "${doc.lifecycle.future_change_mentioned}". Distinguish current vs upcoming behaviour when answering.`);
      if (doc.content_truncated) notes.push("Content truncated to ZD_MAX_CONTENT_CHARS; see canonical URL for full text.");
      return ok("get_help_article", doc, [doc.source], notes);
    }),
  );

  server.registerTool(
    "search_developer_docs",
    {
      title: "Search Zendesk developer docs",
      description:
        "Search developer.zendesk.com (API reference, apps framework, SDKs). Ranks pages from the official sitemap by URL slug, then fetches the top pages live for title, snippet and deprecation badges. " +
        "Use endpoint/resource names as they appear in URLs (e.g. 'ticket audits', 'webhooks', 'custom objects', 'oauth tokens').",
      inputSchema: {
        query: z.string().min(1).max(200),
        max_results: z.number().int().min(1).max(10).optional().describe("Default 5"),
        section: z.enum(["api-reference", "documentation", "any"]).optional().describe("Restrict to API reference or narrative documentation"),
        fetch_pages: z.boolean().optional().describe("Set false to skip live page fetches (faster; titles derived from URLs)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => guard("search_developer_docs", async () => {
      const r = await dev.search(a.query, { maxResults: a.max_results, section: a.section, fetchPages: a.fetch_pages });
      return ok("search_developer_docs", { results: r.results, other_candidate_urls: r.candidates.slice(r.results.length) }, citationsOf(r.results), r.notes, { conflicts: orUndefined(detectConflicts(r.results)) });
    }),
  );

  server.registerTool(
    "get_developer_page",
    {
      title: "Get Zendesk developer docs page",
      description: "Fetch and clean one developer.zendesk.com page (API reference, guide, changelog). Returns markdown-ish text, headings, badges (e.g. Deprecated) and lifecycle classification.",
      inputSchema: { url: z.string().url().describe("Must be on developer.zendesk.com") },
      annotations: READ_ONLY,
    },
    async (a) => guard("get_developer_page", async () => {
      const doc = await dev.getPage(a.url);
      const notes: string[] = [];
      if (doc.lifecycle.status !== "current") notes.push(`Page classified as ${doc.lifecycle.status} (${doc.lifecycle.confidence}, scope=${doc.lifecycle.scope}); evidence: ${doc.lifecycle.evidence.slice(0, 3).join("; ")}`);
      if (doc.lifecycle.scope === "partial") notes.push("Lifecycle keywords were found in the body only: likely one endpoint/field/parameter on this page is affected while the rest is current. Quote the specific note when answering.");
      return ok("get_developer_page", doc, [doc.source], notes);
    }),
  );

  server.registerTool(
    "get_zendesk_changes",
    {
      title: "Get Zendesk changes (changelog, release notes, announcements)",
      description:
        "What changed and when: merges the official developer changelog (developer.zendesk.com) with the 'Zendesk updates' feeds on support.zendesk.com (Announcements, Developer updates, Release notes, What's new). " +
        "Each item carries change_type (breaking_change, deprecated, removed, new, update, beta, eap, release_notes, announcement), dates and lifecycle.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Keywords to filter, e.g. 'offset pagination' or 'OAuth tokens'. Omit for the newest changes."),
        since: z.string().optional().describe("Only changes announced on/after this date (ISO yyyy-mm-dd or 'Aug 1, 2026')"),
        locale: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)?$/i).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
        feeds: z.array(z.enum(["developer_changelog", "developer_updates", "announcements", "release_notes", "whats_new"])).optional().describe("Restrict to specific feeds"),
      },
      annotations: READ_ONLY,
    },
    async (a) => guard("get_zendesk_changes", async () => {
      const r = await changes.getChanges({ query: a.query, since: a.since, locale: a.locale, limit: a.limit, feeds: a.feeds });
      return ok("get_zendesk_changes", { changes: r.items }, [...r.sources, ...r.items.map((i) => i.source)], r.notes, { conflicts: orUndefined(detectConflicts(r.items)) });
    }),
  );

  server.registerTool(
    "get_zendesk_status",
    {
      title: "Get Zendesk system status",
      description: "Live active incidents and upcoming maintenance from the official Zendesk Status API (status.zendesk.com), optionally filtered to a subdomain. Historical/resolved incidents are not exposed by Zendesk's API.",
      inputSchema: { subdomain: z.string().max(63).optional().describe("Your Zendesk subdomain, e.g. 'acme' for acme.zendesk.com") },
      annotations: READ_ONLY,
    },
    async (a) => guard("get_zendesk_status", async () => {
      const r = await status.getStatus(a.subdomain);
      return ok("get_zendesk_status", { overall: r.overall, active_incidents: r.active, scheduled_maintenance: r.maintenance }, r.sources, r.notes);
    }),
  );

  /* Bonus composite tool: one call to answer "is X current / beta / deprecated?" ---- */
  server.registerTool(
    "get_feature_lifecycle",
    {
      title: "Check a Zendesk feature's lifecycle status",
      description:
        "Composite lookup for questions like 'Is offset pagination deprecated?' or 'Is Copilot GA?'. Searches canonical Help Center docs, developer docs, and the change feeds, " +
        "then returns a consolidated verdict (current/future/beta/eap/deprecated/legacy/retired) with the preferred source and any conflicting sources.",
      inputSchema: {
        feature: z.string().min(2).max(200).describe("Feature, API, or product name"),
        locale: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)?$/i).optional(),
      },
      annotations: READ_ONLY,
    },
    async (a) => guard("get_feature_lifecycle", async () => {
      const [hcRes, devRes, chRes] = await Promise.allSettled([
        hc.search({ query: a.feature, locale: a.locale, perPage: 5 }),
        dev.search(a.feature, { maxResults: 3 }),
        changes.getChanges({ query: a.feature, locale: a.locale, limit: 10 }),
      ]);
      const docs: DocResult[] = [];
      const notes: string[] = [];
      if (hcRes.status === "fulfilled") docs.push(...hcRes.value.results); else notes.push(`Help Center search failed: ${hcRes.reason?.message}`);
      if (devRes.status === "fulfilled") docs.push(...devRes.value.results); else notes.push(`Developer docs search failed: ${devRes.reason?.message}`);
      if (chRes.status === "fulfilled") docs.push(...chRes.value.items); else notes.push(`Change feeds failed: ${chRes.reason?.message}`);
      const conflicts = detectConflicts(docs);
      const verdict = consolidate(a.feature, docs);
      return ok("get_feature_lifecycle", { verdict, evidence: docs.slice(0, 12).map(({ content, ...rest }) => ({ ...rest, excerpt: content.slice(0, 300) })) }, citationsOf(docs), notes, { conflicts: orUndefined(conflicts) });
    }),
  );

  return { server, http, cfg };
}

/* ----------------------------------------------------------------- helpers */

function dedupe(s: Source[]): Source[] {
  const seen = new Set<string>();
  return s.filter((x) => { if (!x || seen.has(x.url)) return false; seen.add(x.url); return true; });
}
function orUndefined<T>(arr: T[]): T[] | undefined { return arr.length ? arr : undefined; }

const RANK: Record<DocResult["authority"], number> = { canonical: 3, changelog: 2, announcement: 1, status: 0 };

/** Pick the most relevant, most authoritative, most recent statement about the feature. */
export function consolidate(feature: string, docs: DocResult[]) {
  const scored = docs.map((d) => ({ d, rel: scoreText(feature, d.title, d.content) })).filter((x) => x.rel > 0);
  if (!scored.length) return { status: "unknown", confidence: "low", reason: "No official documentation matched this feature name.", preferred_source: null };
  const topRel = Math.max(...scored.map((x) => x.rel));
  const pool = scored.filter((x) => x.rel >= Math.max(1, topRel * 0.6));
  const term = (d: DocResult) => ["deprecated", "retired"].includes(d.lifecycle.status) && d.lifecycle.confidence === "high" && d.lifecycle.scope === "whole";
  pool.sort((a, b) => {
    if (term(a.d) !== term(b.d)) return term(a.d) ? -1 : 1;                 // explicit deprecation notices win
    if (Math.abs(a.rel - b.rel) > 0.5) return b.rel - a.rel;                   // then relevance
    return RANK[b.d.authority] - RANK[a.d.authority] || (b.d.updated_at ?? "").localeCompare(a.d.updated_at ?? "");
  });
  const best = pool[0].d;
  const statuses = [...new Set(pool.map((x) => x.d.lifecycle.status))];
  return {
    status: best.lifecycle.status,
    confidence: statuses.length > 1 ? "medium" : best.lifecycle.confidence,
    scope: best.lifecycle.scope,
    effective_date: best.lifecycle.effective_date ?? best.effective_date,
    future_change_mentioned: best.lifecycle.future_change_mentioned,
    reason: `Based on "${best.title}" (${best.authority}${best.updated_at ? ", updated " + best.updated_at.slice(0, 10) : ""}); evidence: ${best.lifecycle.evidence.slice(0, 3).join("; ") || "no lifecycle keywords found"}.${statuses.length > 1 ? ` Other relevant sources report: ${statuses.filter((s) => s !== best.lifecycle.status).join(", ")} — see conflicts/evidence.` : ""}`,
    preferred_source: best.url,
    plan_requirements: best.plan_requirements,
    product: best.product,
    considered: pool.slice(0, 6).map((x) => ({ url: x.d.url, status: x.d.lifecycle.status, relevance: Number(x.rel.toFixed(2)) })),
  };
}
