import * as cheerio from "cheerio";
import { OFFICIAL_HOSTS, type Config } from "../config.js";
import type { HttpClient } from "../util/http.js";
import { parseDate, classifyLifecycle, scoreText } from "../util/classify.js";
import { htmlToText } from "../util/html.js";
import { isOfficialUrl } from "../util/http.js";
import type { DocResult, Source } from "../types.js";
import type { HelpCenterSource } from "./helpCenter.js";

export const DEV_CHANGELOG_URL = `https://${OFFICIAL_HOSTS.developer}/api-reference/changelog/changelog/`;

export interface ChangelogEntry {
  date: string;              // yyyy-mm-dd
  event: string;             // "Deprecated" | "Breaking change" | "New" | "Update" | ...
  subject: string;
  subject_url?: string;
  description: string;
}

export interface ChangeItem extends DocResult {
  /** Off-site link Zendesk attached to the entry (e.g. GitHub). Informational only — not an official Zendesk source. */
  external_link?: string;
  change_type: string;       // normalised event (deprecated, breaking_change, new, update, beta, eap, removed, announcement, release_notes, ...)
  date: string;              // announcement/publication date yyyy-mm-dd
  feed: "developer_changelog" | "developer_updates" | "announcements" | "release_notes" | "whats_new";
}

export class ChangesSource {
  constructor(private http: HttpClient, private cfg: Config, private hc: HelpCenterSource) {}
  private ttl(kind: keyof Config["cacheTtlS"]) { return this.cfg.cacheTtlS[kind] * 1000; }

  /** Parse the official developer changelog table (Date | Event | Subject | Description). */
  async developerChangelog(): Promise<{ entries: ChangelogEntry[]; retrievedAt: string; cached: boolean }> {
    const r = await this.http.get(DEV_CHANGELOG_URL, { ttlMs: this.ttl("search") });
    return { entries: parseChangelogHtml(r.body), retrievedAt: r.retrievedAt, cached: r.cached };
  }

  async getChanges(opts: { query?: string; since?: string; locale?: string; limit?: number; feeds?: ChangeItem["feed"][] }): Promise<{ items: ChangeItem[]; notes: string[]; sources: Source[] }> {
    const locale = (opts.locale ?? this.cfg.defaultLocale).toLowerCase();
    const since = opts.since ? parseDate(opts.since) ?? opts.since.slice(0, 10) : undefined;
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const query = opts.query?.trim() ?? "";
    const feeds = new Set(opts.feeds ?? ["developer_changelog", "developer_updates", "announcements", "release_notes", "whats_new"]);
    const notes: string[] = [];
    const sources: Source[] = [];
    const items: ChangeItem[] = [];

    // 1) developer.zendesk.com changelog ---------------------------------
    if (feeds.has("developer_changelog")) {
      try {
        const { entries, retrievedAt, cached } = await this.developerChangelog();
        sources.push({ kind: "developer_changelog", url: DEV_CHANGELOG_URL, title: "Zendesk developer changelog", retrieved_at: retrievedAt, from_cache: cached });
        for (const e of entries) {
          if (since && e.date < since) continue;
          if (query && scoreText(query, e.subject, e.description) === 0) continue;
          const text = `${e.subject}: ${e.description}`;
          const lifecycle = classifyLifecycle({ title: e.subject, text, labels: [e.event] });
          const official = e.subject_url && isOfficialUrl(e.subject_url) ? e.subject_url : undefined;
          items.push({
            title: `${e.event}: ${e.subject}`,
            url: official ?? DEV_CHANGELOG_URL,
            external_link: e.subject_url && !official ? e.subject_url : undefined,
            content: e.description,
            content_truncated: false,
            created_at: e.date,
            updated_at: e.date,
            effective_date: lifecycle.effective_date ?? extractEffective(e.description),
            plan_requirements: [],
            lifecycle: { ...lifecycle, status: eventToLifecycle(e.event) ?? lifecycle.status, confidence: "high", scope: "whole", evidence: [`changelog event tag: ${e.event}`, ...lifecycle.evidence] },
            authority: "changelog",
            change_type: normaliseEvent(e.event),
            date: e.date,
            feed: "developer_changelog",
            source: { kind: "developer_changelog", url: DEV_CHANGELOG_URL, title: `Developer changelog — ${e.date} — ${e.subject}`, retrieved_at: retrievedAt, from_cache: cached },
          });
        }
      } catch (e) {
        notes.push(`Developer changelog unavailable: ${(e as Error).message}`);
      }
    }

    // 2) support.zendesk.com "Zendesk updates" category ----------------------
    const scopes = await this.hc.resolveUpdateScopes(locale);
    const hcFeeds: [ChangeItem["feed"], number | undefined][] = [
      ["announcements", scopes.sections.announcements],
      ["developer_updates", scopes.sections.developerUpdates],
      ["release_notes", scopes.sections.releaseNotes],
      ["whats_new", scopes.sections.whatsNew],
    ];
    if (query) {
      // one search across the whole updates category, filtered client-side by section
      try {
        const wanted = new Set(hcFeeds.filter(([f]) => feeds.has(f)).map(([, id]) => id));
        for (let page = 1; page <= 3; page++) {
          const res = await this.hc.search({ query, locale, categoryId: scopes.categoryId, createdAfter: since, sortBy: "created_at", perPage: 30, page });
          for (const r of res.results) {
            const feed = feedFromKind(r.source.kind);
            if (!feed || !feeds.has(feed)) continue;
            items.push(toChangeItem(r, feed));
          }
          if (res.results.length) sources.push(res.results[0].source && { kind: "help_center", url: `https://${OFFICIAL_HOSTS.support}/hc/${locale}/categories/${scopes.categoryId}`, title: "Zendesk updates (search)", retrieved_at: res.results[0].source.retrieved_at, from_cache: res.results[0].source.from_cache });
          if (!res.pagination.next_page || items.length >= limit * 2) break;
        }
        void wanted;
      } catch (e) { notes.push(`Help Center updates search failed: ${(e as Error).message}`); }
    } else {
      // no query: list newest articles per section
      for (const [feed, sectionId] of hcFeeds) {
        if (!feeds.has(feed) || !sectionId) continue;
        try {
          for (let page = 1; page <= 3; page++) {
            const { articles, retrievedAt, cached, nextPage } = await this.hc.listArticles({ sectionId }, locale, 30, page);
            sources.push({ kind: feed === "announcements" ? "announcement" : feed === "release_notes" ? "release_notes" : feed === "whats_new" ? "whats_new" : "developer_update", url: `https://${OFFICIAL_HOSTS.support}/hc/${locale}/sections/${sectionId}`, title: `Zendesk ${feed.replace("_", " ")} section`, retrieved_at: retrievedAt, from_cache: cached });
            let stop = !nextPage;
            for (const a of articles) {
              if (since && a.created_at.slice(0, 10) < since) { stop = true; continue; }
              items.push(toChangeItem(this.hc.toResult(a, "", retrievedAt, cached, { snippet: false }), feed));
            }
            if (stop) break;
          }
        } catch (e) { notes.push(`Could not list ${feed}: ${(e as Error).message}`); }
      }
    }

    // de-dupe & sort newest first
    const seen = new Set<string>();
    const merged = items.filter((i) => { const k = i.url + "|" + i.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!merged.length) notes.push(since ? `No changes found since ${since}${query ? ` matching "${query}"` : ""}.` : "No changes found.");
    notes.push("Ordering: developer changelog and release notes are authoritative for *what changed*; canonical product docs remain authoritative for *current behaviour*. Verify effective dates on the cited page.");
    return { items: merged.slice(0, limit), notes, sources: dedupeSources(sources) };
  }
}

/* ------------------------------------------------------------------ helpers */

export function parseChangelogHtml(html: string): ChangelogEntry[] {
  const $ = cheerio.load(html);
  const out: ChangelogEntry[] = [];
  $("table").each((_, table) => {
    const headers = $(table).find("thead th, tr:first-child th").map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (!headers.includes("date") || !headers.includes("event")) return;
    const col = (name: string) => headers.indexOf(name);
    $(table).find("tbody tr").each((_, tr) => {
      const cells = $(tr).children("td");
      if (cells.length < 3) return;
      const date = parseDate($(cells[col("date")]).text());
      if (!date) return;
      const subjCell = $(cells[col("subject")]);
      const href = subjCell.find("a").first().attr("href");
      const desc = htmlToText($(cells[col("description")]).html() ?? "", DEV_CHANGELOG_URL).text.replace(/\s+/g, " ").trim();
      out.push({
        date,
        event: $(cells[col("event")]).text().trim() || "Update",
        subject: subjCell.text().replace(/\s+/g, " ").trim(),
        subject_url: href ? new URL(href, DEV_CHANGELOG_URL).toString() : undefined,
        description: desc,
      });
    });
  });
  return out;
}

export function normaliseEvent(ev: string): string {
  const e = ev.toLowerCase();
  if (/breaking/.test(e)) return "breaking_change";
  if (/deprecat/.test(e)) return "deprecated";
  if (/remov|retire|sunset|end of life/.test(e)) return "removed";
  if (/eap|early access/.test(e)) return "eap";
  if (/beta/.test(e)) return "beta";
  if (/new|launch|release/.test(e)) return "new";
  if (/update|change|improve/.test(e)) return "update";
  return e.replace(/\s+/g, "_") || "update";
}

function eventToLifecycle(ev: string): DocResult["lifecycle"]["status"] | undefined {
  const n = normaliseEvent(ev);
  return n === "deprecated" ? "deprecated" : n === "removed" ? "retired" : n === "eap" ? "eap" : n === "beta" ? "beta" : undefined;
}

function extractEffective(desc: string): string | undefined {
  const m = /(?:starting|beginning|as of|effective|on|from)\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i.exec(desc);
  return m ? parseDate(m[1]) : undefined;
}

function feedFromKind(kind: Source["kind"]): ChangeItem["feed"] | undefined {
  switch (kind) {
    case "announcement": return "announcements";
    case "developer_update": return "developer_updates";
    case "release_notes": return "release_notes";
    case "whats_new": return "whats_new";
    default: return undefined;
  }
}

function toChangeItem(r: DocResult, feed: ChangeItem["feed"]): ChangeItem {
  const t = r.title.toLowerCase();
  const change_type = /breaking/.test(t) ? "breaking_change" : /deprecat/.test(t) ? "deprecated" : /retir|remov|end of life|sunset/.test(t) ? "removed" : /eap|early access/.test(t) ? "eap" : /beta/.test(t) ? "beta" : feed === "release_notes" ? "release_notes" : /announc|introduc|launch|new /.test(t) ? "new" : "announcement";
  return { ...r, change_type, date: (r.created_at ?? r.updated_at ?? "").slice(0, 10), feed };
}

function dedupeSources(s: Source[]): Source[] {
  const seen = new Set<string>();
  return s.filter((x) => { if (!x || seen.has(x.url)) return false; seen.add(x.url); return true; });
}
