import { describe, it, expect } from "vitest";
import { HelpCenterSource, parseArticleRef } from "../src/sources/helpCenter.js";
import { HttpClient } from "../src/util/http.js";
import { Logger } from "../src/util/log.js";
import { article, mockFetch, testConfig } from "./helpers.js";

const HC = "https://support.zendesk.com/api/v2/help_center";
const taxonomy = {
  [`${HC}/en-us/sections.json`]: { json: { sections: [{ id: 5634465167514, name: "Business rules", category_id: 6191910393754 }, { id: 4405298889242, name: "Developer updates", category_id: 4405298749210 }], next_page: null } },
  [`${HC}/en-us/categories.json`]: { json: { categories: [{ id: 6191910393754, name: "Product guides" }, { id: 4405298749210, name: "Zendesk updates" }] } },
};
const mk = (routes: Record<string, any>) => {
  const f = mockFetch({ ...taxonomy, ...routes });
  const cfg = testConfig();
  return { f, hc: new HelpCenterSource(new HttpClient(cfg, new Logger("silent"), f, async () => {}), cfg) };
};

describe("parseArticleRef", () => {
  it("accepts ids and official URLs", () => {
    expect(parseArticleRef("4408893545882")).toEqual({ id: 4408893545882 });
    expect(parseArticleRef("https://support.zendesk.com/hc/de/articles/4408893545882-Titel")).toEqual({ id: 4408893545882, locale: "de" });
    expect(parseArticleRef("https://support.zendesk.com/api/v2/help_center/en-us/articles/123456.json")).toEqual({ id: 123456, locale: "en-us" });
  });
  it("rejects other hosts and non-article URLs", () => {
    expect(() => parseArticleRef("https://acme.zendesk.com/hc/en-us/articles/123456")).toThrow(/Only support.zendesk.com/);
    expect(() => parseArticleRef("https://support.zendesk.com/hc/en-us/sections/1")).toThrow(/does not point/);
  });
});

describe("HelpCenterSource", () => {
  it("search maps API hits to DocResults with citations, plans, lifecycle and pagination", async () => {
    const { f, hc } = mk({
      [`${HC}/articles/search.json`]: { json: { results: [article(), article({ id: 2, title: "Draft thing", draft: true })], count: 2, page: 1, page_count: 1, per_page: 10, next_page: null } },
    });
    const r = await hc.search({ query: "trigger conditions", product: "Support" });
    expect(f.calls[0]).toContain("/articles/search.json?query=trigger+conditions&locale=en-us&per_page=10&page=1");
    expect(r.results).toHaveLength(1); // drafts removed
    const d = r.results[0];
    expect(d.url).toContain("support.zendesk.com/hc/en-us/articles/4408893545882");
    expect(d.plan_requirements[1].product).toBe("Support");
    expect(d.product).toEqual(expect.arrayContaining(["Support", "Suite"]));
    expect(d.breadcrumbs).toEqual(["Product guides", "Business rules"]);
    expect(d.lifecycle.status).toBe("current");
    expect(d.authority).toBe("canonical");
    expect(d.source.kind).toBe("help_center");
    expect(d.updated_at).toBe("2026-05-06T18:58:36Z");
    expect(r.pagination).toEqual({ page: 1, per_page: 10, page_count: 1, total: 2, next_page: null });
  });
  it("getArticle returns full cleaned content and classifies announcements", async () => {
    const { hc } = mk({
      [`${HC}/en-us/articles/99.json`]: { json: { article: article({ id: 99, section_id: 4405298889242, title: "Deprecation of password access for APIs", html_url: "https://support.zendesk.com/hc/en-us/articles/99", body: "<table><tr><td>Announced on</td><td>Rollout starts</td><td>Rollout ends</td></tr><tr><td>July 1, 2024</td><td>July 31, 2024</td><td>January 12, 2026</td></tr></table><p>Password access is deprecated.</p>" }) } },
    });
    const d = await hc.getArticle("https://support.zendesk.com/hc/en-us/articles/99-Deprecation");
    expect(d.lifecycle.status).toBe("deprecated");
    expect(d.lifecycle.rollout_end_date).toBe("2026-01-12");
    expect(d.source.kind).toBe("developer_update");
    expect(d.authority).toBe("announcement");
    expect(d.content).toContain("| Announced on |");
  });
  it("getArticle returns headings and flags a heading that matches nothing", async () => {
    const { hc } = mk({ [`${HC}/en-us/articles/4408893545882.json`]: { json: { article: article() } } });
    const d = await hc.getArticle("4408893545882", undefined, "nope");
    expect(d.headings).toEqual(["Conditions"]);
    expect(d.heading_not_found).toBe("nope");
    expect(d.content).toContain("## Conditions");
  });
  it("surfaces restricted (401) articles with a helpful error", async () => {
    const { hc } = mk({ [`${HC}/en-us/articles/12345.json`]: { status: 401, body: "{}" } });
    await expect(hc.getArticle("12345")).rejects.toMatchObject({ code: "RESTRICTED" });
  });
  it("resolves update scopes by name with fallbacks", async () => {
    const { hc } = mk({});
    const s = await hc.resolveUpdateScopes();
    expect(s.categoryId).toBe(4405298749210);
    expect(s.sections.developer_updates).toBe(4405298889242);
    expect(s.sections.release_notes).toBe(4405298847002); // fallback id
  });
  it("a non-English call does not poison the taxonomy for English calls", async () => {
    const { hc } = mk({
      [`${HC}/de/sections.json`]: { json: { sections: [{ id: 4405298889242, name: "Entwickler-Updates", category_id: 4405298749210 }], next_page: null } },
      [`${HC}/de/categories.json`]: { json: { categories: [{ id: 4405298749210, name: "Zendesk-Updates" }] } },
      [`${HC}/articles/search.json`]: { json: { results: [article({ section_id: 4405298889242 })], count: 1, page: 1, page_count: 1, per_page: 10, next_page: null } },
    });
    await hc.search({ query: "x", locale: "de" });
    expect((await hc.search({ query: "x" })).results[0].source.kind).toBe("developer_update");
  });
});
