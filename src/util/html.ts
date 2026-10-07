import * as cheerio from "cheerio";
import type { PlanRequirement } from "../types.js";

/** Elements that never carry documentation content. */
const STRIP = "script, style, noscript, svg, iframe, nav, header, footer, form, button, [aria-hidden='true'], .sr-only";

export interface CleanedHtml {
  text: string;
  headings: string[];
  links: { text: string; href: string }[];
  summary?: string;
  plan_requirements: PlanRequirement[];
}

/** Convert a fragment of HTML into readable, markdown-flavoured plain text. */
export function htmlToText(html: string, baseUrl?: string): CleanedHtml {
  const $ = cheerio.load(html, { xml: false });
  $(STRIP).remove();

  // Zendesk help-center specifics ---------------------------------------
  const summary = $("#docs-ai-summary-content").text().trim() || undefined;
  $("#docs-ai-summary, #docs-hc-snippet, #docs-wmp-link").remove();
  const plan_requirements = extractPlanBanners($);
  $(".article-banners").remove();

  // developer.zendesk.com specifics: drop "On this page" TOC blocks & footers
  $("*").filter((_, el) => {
    const t = $(el).children("h2,h3,p,div,span").first().text().trim();
    return /^on this page$/i.test(t) && $(el).find("a").length > 0 && $(el).text().length < 3000;
  }).remove();

  const headings: string[] = [];
  const links: { text: string; href: string }[] = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    try { links.push({ text, href: baseUrl ? new URL(href, baseUrl).toString() : href }); } catch { /* ignore */ }
  });

  const render = (el: cheerio.Cheerio<any>, depth = 0): string => {
    let out = "";
    el.contents().each((_, node) => {
      if (node.type === "text") { out += (node as any).data.replace(/\s+/g, " "); return; }
      if (node.type !== "tag") return;
      const $n = $(node);
      const tag = (node as any).tagName?.toLowerCase();
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
          const lvl = Number(tag[1]);
          const t = $n.text().replace(/\s+/g, " ").trim();
          if (t) { headings.push(t); out += `\n\n${"#".repeat(Math.min(lvl, 4))} ${t}\n\n`; }
          break;
        }
        case "p": out += `\n\n${render($n, depth).trim()}\n\n`; break;
        case "br": out += "\n"; break;
        case "hr": out += "\n\n---\n\n"; break;
        case "li": out += `\n${"  ".repeat(depth)}- ${render($n, depth + 1).trim()}`; break;
        case "ul": case "ol": out += `\n${render($n, depth)}\n`; break;
        case "pre": out += `\n\n\`\`\`\n${$n.text().trim()}\n\`\`\`\n\n`; break;
        case "code": out += `\`${$n.text().trim()}\``; break;
        case "strong": case "b": out += `**${render($n, depth).trim()}**`; break;
        case "em": case "i": out += `_${render($n, depth).trim()}_`; break;
        case "a": out += render($n, depth); break;
        case "img": { const alt = $n.attr("alt"); if (alt) out += `[image: ${alt}]`; break; }
        case "table": out += `\n\n${renderTable($, $n)}\n\n`; break;
        case "blockquote": out += `\n\n> ${render($n, depth).trim().replace(/\n/g, "\n> ")}\n\n`; break;
        default: out += render($n, depth);
      }
    });
    return out;
  };

  const text = render($("body").length ? $("body") : $.root())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, headings, links, summary, plan_requirements };
}

function renderTable($: cheerio.CheerioAPI, t: cheerio.Cheerio<any>): string {
  const rows: string[][] = [];
  t.find("tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr).children("th,td").each((_, c) => { cells.push($(c).text().replace(/\s+/g, " ").trim()); });
    if (cells.some(Boolean)) rows.push(cells);
  });
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** Parse Zendesk's "plan availability" banners (e.g. `<div class="article-banner" id="suite_all">`). */
export function extractPlanBanners($: cheerio.CheerioAPI): PlanRequirement[] {
  const out: PlanRequirement[] = [];
  $(".article-banners .article-banner, .article-banner").each((_, el) => {
    const $el = $(el);
    let product = $el.find("strong").first().text().replace(/\s+/g, " ").trim() || $el.attr("id") || "Unknown";
    const cells = $el.find("td").map((_, c) => $(c).text().replace(/\s+/g, " ").trim()).get();
    const raw = cells.join(" — ") || $el.text().replace(/\s+/g, " ").trim();
    let planText = cells[cells.length - 1] ?? raw;
    // "Support with" + "Live chat and messaging Team, Professional, or Enterprise" -> product "Support with Live chat and messaging"
    if (/\bwith$/i.test(product)) {
      const m = /^(.*?)\s+((?:Team|Growth|Professional|Enterprise|Suite|Lite|Essential|Starter)\b.*)$/i.exec(planText);
      if (m) { product = `${product} ${m[1]}`.trim(); planText = m[2]; }
    }
    // "Add-on — Copilot" -> product "Copilot", plans ["Add-on"]
    if (/^add-?ons?$/i.test(product)) { const p = product; product = planText.trim(); planText = p; }
    const plans = planText
      .replace(/\b(or|and)\b/gi, ",")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s && !/^all$/i.test(s) && s !== product);
    out.push({ product: product.replace(/^All\s+/i, "").replace(/^Suites$/i, "Suite"), plans, raw });
  });
  return out;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return { text: (at > max * 0.6 ? cut.slice(0, at + 1) : cut) + "\n\n[...truncated; fetch the canonical URL for the full text]", truncated: true };
}

/** Build a short snippet around the best keyword match. */
export function snippetAround(text: string, query: string, len = 400): string {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (best < 0 || i < best)) best = i; }
  if (best < 0) return text.slice(0, len).trim() + (text.length > len ? "…" : "");
  const start = Math.max(0, best - Math.floor(len / 3));
  return (start > 0 ? "…" : "") + text.slice(start, start + len).trim() + (start + len < text.length ? "…" : "");
}
