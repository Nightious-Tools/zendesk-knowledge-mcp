import type { Conflict, DocResult, Lifecycle, LifecycleInfo } from "../types.js";

/* ---------------------------------------------------------------- dates */

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_RE = new RegExp(`\\b(?:(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})|(\\d{1,2})\\s+(${MONTHS})\\.?\\s+(\\d{4})|(\\d{4})-(\\d{2})-(\\d{2}))(?!\\d)`, "i");

/** Parse a human date ("Aug 6, 2026", "6 August 2026", "2026-08-06") to ISO yyyy-mm-dd. */
export function parseDate(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const m = DATE_RE.exec(s);
  if (!m) return undefined;
  let y: number, mo: number, d: number;
  if (m[7]) { y = +m[7]; mo = +m[8]; d = +m[9]; }
  else if (m[1]) { y = +m[3]; mo = monthIndex(m[1]); d = +m[2]; }
  else { y = +m[6]; mo = monthIndex(m[5]); d = +m[4]; }
  if (!mo || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return isNaN(dt.getTime()) || dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1 ? undefined : dt.toISOString().slice(0, 10);
}

function monthIndex(name: string): number {
  const n = name.toLowerCase().slice(0, 3);
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(n) + 1;
}

/** Zendesk announcement tables: "Announced on | Rollout starts | Rollout ends" */
export function extractAnnouncementDates(text: string): { announced?: string; rolloutStart?: string; rolloutEnd?: string } {
  const out: { announced?: string; rolloutStart?: string; rolloutEnd?: string } = {};
  // Markdown table produced by htmlToText: header row, separator, value row.
  const tbl = /\|([^|\n]*)\|([^|\n]*)\|(?:([^|\n]*)\|)?\s*\n\|[-\s|]+\|\s*\n\|([^|\n]*)\|([^|\n]*)\|(?:([^|\n]*)\|)?/.exec(text);
  if (tbl && /announced|rollout/i.test(tbl[1] + tbl[2] + (tbl[3] ?? ""))) {
    const cols = [[tbl[1], tbl[4]], [tbl[2], tbl[5]], [tbl[3] ?? "", tbl[6] ?? ""]];
    for (const [h, v] of cols) {
      const d = parseDate(v);
      if (!d) continue;
      if (/announced/i.test(h)) out.announced = d;
      else if (/rollout\s+ends?/i.test(h) || /deprecated on/i.test(h)) out.rolloutEnd = d;
      else if (/rollout|starts|begins/i.test(h)) out.rolloutStart = d;
    }
    if (out.announced || out.rolloutStart || out.rolloutEnd) return out;
  }
  const grab = (label: RegExp) => {
    const m = new RegExp(label.source + String.raw`[^A-Za-z0-9]{0,40}(.{0,40})`, "i").exec(text);
    return m ? parseDate(m[1]) : undefined;
  };
  out.announced = grab(/announced\s+on/);
  out.rolloutStart = grab(/(?:rollout|roll-out)\s+(?:starts?|on|begins?)/) ?? grab(/new api rollout on/);
  out.rolloutEnd = grab(/(?:rollout|roll-out)\s+ends?/) ?? grab(/(?:old api )?deprecated on/);
  // Tabular variant: header row then a row of dates in the same order.
  if (!out.announced && /announced on/i.test(text)) {
    const dates = [...text.matchAll(new RegExp(DATE_RE.source, "gi"))].map((m) => parseDate(m[0])).filter(Boolean) as string[];
    if (dates.length >= 1) out.announced = dates[0];
    if (dates.length >= 2 && !out.rolloutStart) out.rolloutStart = dates[1];
    if (dates.length >= 3 && !out.rolloutEnd) out.rolloutEnd = dates[2];
  }
  return out;
}

/* ------------------------------------------------------------ lifecycle */

interface Rule { status: Lifecycle; re: RegExp; weight: number }
const GA_RE = /\b(general availability|generally available|now available to all|\bGA\b)/i;
const RULES: Rule[] = [
  { status: "retired",    re: /\b(retired|end[- ]of[- ]life|EOL|sunset(?:ted)?|has been removed|no longer available|discontinued|shut ?down)\b/i, weight: 3 },
  { status: "deprecated", re: /\bdeprecat(?:ed|ion)\b/i, weight: 3 },
  { status: "legacy",     re: /\blegacy\b/i, weight: 2 },
  { status: "eap",        re: /\b(early access(?: program)?|EAP)\b/, weight: 3 },
  { status: "beta",       re: /\bbeta\b/i, weight: 2 },
  { status: "future",     re: new RegExp(String.raw`\b(coming soon|will be (?:available|rolled out|released|introduced)|upcoming|planned for|scheduled for|starting (?:on )?(?:${MONTHS})|rollout (?:starts|begins))`, "i"), weight: 2 },
];

export interface ClassifyInput {
  title: string;
  text: string;
  labels?: string[];
  breadcrumbs?: string[];
  today?: Date;
  /** Release notes / "what's new" digests list many items; their lifecycle is not classifiable as one status. */
  compilation?: boolean;
}

/**
 * Classify the lifecycle status a document describes.
 * Title / breadcrumb / label hits are strong; body hits beyond the lead are weak,
 * because a current-feature doc often *mentions* a deprecated alternative.
 */
export function classifyLifecycle(input: ClassifyInput): LifecycleInfo {
  const today = input.today ?? new Date();
  const title = input.title ?? "";
  const lead = input.text.slice(0, 800);
  const rest = input.text.slice(800);
  const meta = [...(input.labels ?? []), ...(input.breadcrumbs ?? [])].join(" ");
  const todayStr = today.toISOString().slice(0, 10);
  const scores = new Map<Lifecycle, number>();
  const evidence: string[] = [];
  let strongHit = false; // title/label hit => the whole document is about that status
  const bump = (s: Lifecycle, w: number, why: string) => {
    scores.set(s, (scores.get(s) ?? 0) + w);
    if (evidence.length < 8) evidence.push(why);
  };
  const dates = extractAnnouncementDates(input.text);
  let effective = dates.rolloutStart ?? dates.rolloutEnd;

  if (input.compilation) {
    return { status: "current", confidence: "medium", scope: "compilation", evidence: ["digest of many items; check each item's own status"], announced_date: dates.announced };
  }

  for (const r of RULES) {
    if (r.re.test(title)) { strongHit = true; bump(r.status, r.weight * 3, `title: "${title.match(r.re)?.[0]}"`); }
    if (r.re.test(meta)) { strongHit = true; bump(r.status, r.weight * 2, `label/section: "${meta.match(r.re)?.[0]}"`); }
    if (r.re.test(lead)) bump(r.status, r.weight * 2, `lead: "${lead.match(r.re)?.[0]}"`);
    if (r.re.test(rest)) bump(r.status, r.weight * 0.5, `body mentions "${rest.match(r.re)?.[0]}"`);
  }
  // "General availability" in the title/lead means the thing is *now* current, even if the body recalls its beta/EAP past.
  if (GA_RE.test(title) || GA_RE.test(lead)) {
    bump("current", 8, `GA signal: "${(title.match(GA_RE) ?? lead.match(GA_RE))?.[0]}"`);
    for (const s of ["beta", "eap", "future"] as Lifecycle[]) scores.set(s, (scores.get(s) ?? 0) / 4);
  }
  // A rollout that has already completed is no longer "future" even if the text says "will be".
  if (effective && effective <= todayStr && !(dates.rolloutEnd && dates.rolloutEnd > todayStr)) {
    scores.set("future", 0);
    evidence.push(`rollout started ${effective}${dates.rolloutEnd ? ", ended " + dates.rolloutEnd : ""} (past)`);
  }
  let future_change_mentioned: string | undefined;
  const starting = /(?:starting|beginning|as of|effective)\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i.exec(input.text);
  if (starting) {
    const d = parseDate(starting[1]);
    if (d && !effective) effective = d;
    if (d && d > todayStr) {
      future_change_mentioned = starting[0];
      bump("future", 3, `future-dated: "${starting[0]}"`);
    }
  }
  // An announced rollout entirely in the past is a completed change -> current/deprecated etc. stands.
  if (effective && effective > todayStr) bump("future", 10, `rollout/effective date ${effective} is in the future`);
  else if (dates.rolloutStart && dates.rolloutEnd && dates.rolloutStart <= todayStr && dates.rolloutEnd > todayStr) bump("future", 3, `rollout in progress (${dates.rolloutStart} → ${dates.rolloutEnd}); availability varies by account until it completes`);

  let best: Lifecycle = "current";
  let bestScore = 0;
  for (const [s, v] of scores) if (v > bestScore) { best = s; bestScore = v; }
  // Weak body-only mentions do not change the status of an otherwise current doc.
  if (bestScore < 2) best = "current";
  let confidence: LifecycleInfo["confidence"] = bestScore >= 6 ? "high" : bestScore >= 2 ? "medium" : input.text.length ? "medium" : "low";
  let scope: LifecycleInfo["scope"] = "whole";
  if (best !== "current" && !strongHit) {
    // Signal came from the body only: a reference page may deprecate one endpoint while the rest is current.
    scope = "partial";
    if (confidence === "high") confidence = "medium";
    evidence.push("status keywords appear in the body but not the title/labels; may apply to only part of this page");
  }

  return {
    status: best,
    confidence: best === "current" && bestScore === 0 ? "medium" : confidence,
    scope,
    evidence,
    effective_date: effective,
    announced_date: dates.announced,
    rollout_end_date: dates.rolloutEnd,
    future_change_mentioned,
  };
}

/* ------------------------------------------------------------- products */

const PRODUCTS: [string, RegExp][] = [
  ["Support", /\bsupport\b|\bticket(?:ing)?\b|\btrigger|\bautomation|\bviews?\b|\bmacros?\b/i],
  ["Guide", /\bguide\b|\bhelp center\b|\bknowledge base\b|\barticles?\b/i],
  ["Messaging", /\bmessaging\b|\bweb widget\b|\bsunshine conversations\b|\bsunco\b/i],
  ["Chat", /\bchat\b(?! ?gpt)/i],
  ["Talk", /\btalk\b|\bvoice\b|\bIVR\b/i],
  ["Explore", /\bexplore\b|\breporting\b|\bdashboards?\b/i],
  ["Sell", /\bsell\b|\bCRM\b|\bdeals?\b|\bleads?\b/i],
  ["AI agents", /\bAI agents?\b|\banswer bot\b|\bautomated resolutions?\b/i],
  ["Copilot", /\bcopilot\b|\bagent copilot\b/i],
  ["Workforce management", /\bworkforce management\b|\bWFM\b|\btymeshift\b/i],
  ["Quality assurance", /\bquality assurance\b|\bQA\b|\bklaus\b/i],
  ["Admin Center", /\badmin center\b/i],
  ["Apps & API", /\bAPI\b|\bapps? framework\b|\bZAF\b|\bwebhooks?\b|\bmarketplace\b/i],
  ["Gather", /\bgather\b|\bcommunity\b/i],
];

/** Guess which Zendesk products a doc is about from labels, breadcrumbs and title. */
export function detectProducts(title: string, labels: string[] = [], breadcrumbs: string[] = [], planProducts: string[] = []): string[] {
  const hay = [title, ...labels, ...breadcrumbs].join(" | ");
  const found = new Set<string>(planProducts.map((p) => p.replace(/^(All\s+)?/i, "").replace(/s$/, ""))
    .map((p) => (p.toLowerCase() === "suite" ? "Suite" : p)));
  for (const [name, re] of PRODUCTS) if (re.test(hay)) found.add(name);
  return [...found];
}

/* ------------------------------------------------------------ conflicts */

export const AUTHORITY_RANK: Record<DocResult["authority"], number> = { canonical: 3, changelog: 2, announcement: 1, status: 0 };

/**
 * Detect documents about the same topic that disagree on lifecycle status,
 * and pick a winner using: canonical > changelog > announcement, with a newer
 * changelog/announcement that declares deprecation/retirement overriding an
 * older canonical page (docs sometimes lag deprecation notices).
 */
export function detectConflicts(results: DocResult[]): Conflict[] {
  const groups = new Map<string, DocResult[]>();
  for (const r of results) {
    const key = topicKey(r.title);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const conflicts: Conflict[] = [];
  for (const [topic, docs] of groups) {
    const statuses = new Set(docs.map((d) => d.lifecycle.status));
    if (docs.length < 2 || statuses.size < 2) continue;
    const sorted = [...docs].sort((a, b) => {
      const ar = AUTHORITY_RANK[a.authority], br = AUTHORITY_RANK[b.authority];
      const aTerm = ["deprecated", "retired"].includes(a.lifecycle.status);
      const bTerm = ["deprecated", "retired"].includes(b.lifecycle.status);
      const ad = a.updated_at ?? a.created_at ?? "", bd = b.updated_at ?? b.created_at ?? "";
      // newer non-canonical deprecation notice beats older canonical doc
      if (aTerm !== bTerm && ad !== bd) return (aTerm && ad > bd ? -1 : bTerm && bd > ad ? 1 : br - ar);
      return br - ar || bd.localeCompare(ad);
    });
    const winner = sorted[0];
    conflicts.push({
      topic,
      description: docs.map((d) => `${d.lifecycle.status} per "${d.title}" (${d.authority}${d.updated_at ? ", updated " + d.updated_at.slice(0, 10) : ""})`).join("; "),
      preferred_url: winner.url,
      competing_urls: sorted.slice(1).map((d) => d.url),
      rule: "canonical > changelog > announcement; a newer deprecation/retirement notice overrides an older canonical page. Verify against the preferred source.",
    });
  }
  return conflicts;
}

const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "and", "or", "with", "your", "how", "using", "about", "zendesk", "api", "new", "on", "is", "are", "what", "whats", "what's", "announcing", "announced", "announces", "announcement", "introducing", "update", "updates", "changes", "change", "reference"]);
export function topicKey(title: string): string {
  const toks = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
  return toks.slice(0, 4).sort().join(" ");
}

/* -------------------------------------------------------------- ranking */

export function scoreText(query: string, title: string, body: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  if (!terms.length) return 0;
  const t = title.toLowerCase(), b = body.toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (t.includes(term)) s += 3;
    if (b.includes(term)) s += 1;
  }
  if (t.includes(query.toLowerCase())) s += 5;
  return s / terms.length;
}
