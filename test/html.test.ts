import { describe, it, expect } from "vitest";
import { htmlToText, truncate, snippetAround, sliceSection } from "../src/util/html.js";
import { article } from "./helpers.js";

describe("htmlToText", () => {
  const out = htmlToText(article().body as string, "https://support.zendesk.com/hc/en-us/articles/1");
  it("extracts plan banners", () => {
    expect(out.plan_requirements).toEqual([
      { product: "Suite", plans: ["Team", "Growth", "Professional", "Enterprise", "Enterprise Plus"], raw: "All Suites — Team, Growth, Professional, Enterprise, or Enterprise Plus" },
      { product: "Support", plans: ["Team", "Professional", "Enterprise"], raw: "Support — Team, Professional, or Enterprise" },
    ]);
  });
  it("parses 'Support with ...' and add-on banners", () => {
    const o = htmlToText(`<div class="article-banner"><table><tr><td><strong>Support with</strong></td><td>Live chat and messaging Team, Professional, or Enterprise</td></tr></table></div>
      <div class="article-banner"><table><tr><td><strong>Add-on</strong></td><td>Copilot</td></tr></table></div>`);
    expect(o.plan_requirements[0]).toMatchObject({ product: "Support with Live chat and messaging", plans: ["Team", "Professional", "Enterprise"] });
    expect(o.plan_requirements[1]).toMatchObject({ product: "Copilot", plans: ["Add-on"] });
  });
  it("captures the Zendesk summary and strips hidden snippet/banners", () => {
    expect(out.summary).toBe("Triggers run when tickets are created or updated.");
    expect(out.text).not.toContain("hidden");
    expect(out.text).not.toContain("What's my plan");
  });
  it("renders headings, lists, emphasis and code", () => {
    expect(out.text).toContain("## Conditions");
    expect(out.text).toContain("**conditions**");
    expect(out.text).toContain("- Status");
    expect(out.text).toContain("```\n{\"trigger\": true}\n```");
    expect(out.headings).toEqual(["Conditions"]);
  });
  it("renders tables as markdown and drops scripts/nav", () => {
    const o = htmlToText(`<nav>menu</nav><script>x()</script><table><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody><tr><td>Aug 26, 2026</td><td>Deprecated</td></tr></tbody></table>`);
    expect(o.text).toBe("| Date | Event |\n| --- | --- |\n| Aug 26, 2026 | Deprecated |");
  });
});

describe("sliceSection", () => {
  it("ignores '# comment' lines inside code fences", () => {
    const sec = ["## Setup", "", "```", "# install", "npm i", "```", "", "more setup"];
    const t = [...sec, "", "## Next", "", "other"].join("\n");
    expect(sliceSection(t, "install")).toBeUndefined();
    expect(sliceSection(t, "setup")).toBe(sec.join("\n"));
  });
  it("handles fences in list items, non-Latin and blank requests", () => {
    const t = ["## Setup", "- ```", "# install", "```", "## Next", "x"].join("\n");
    expect(sliceSection(t, "next")).toBe("## Next\nx");
    expect(sliceSection("## 概要\na\n## 設定\nb", "手順")).toBeUndefined();
    expect(sliceSection(t, "  ")).toBeUndefined();
  });
});

describe("truncate / snippet", () => {
  it("truncates at a sentence boundary and flags it", () => {
    const t = truncate("Sentence one. Sentence two. Sentence three is long.", 30);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith("Sentence one. Sentence two.")).toBe(true);
    expect(truncate("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("builds a snippet around the first query term", () => {
    const s = snippetAround("a".repeat(500) + " webhooks are great " + "b".repeat(500), "webhooks", 60);
    expect(s).toContain("webhooks");
    expect(s.startsWith("…")).toBe(true);
  });
});
