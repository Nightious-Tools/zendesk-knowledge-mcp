import { describe, it, expect } from "vitest";
import { parseChangelogHtml, normaliseEvent, ChangesSource, DEV_CHANGELOG_URL } from "../src/sources/changes.js";
import { HelpCenterSource } from "../src/sources/helpCenter.js";
import { HttpClient } from "../src/util/http.js";
import { Logger } from "../src/util/log.js";
import { article, mockFetch, testConfig } from "./helpers.js";

const CHANGELOG = `<html><body><main><h1>Changelog</h1>
<table><thead><tr><th>Date</th><th>Event</th><th>Subject</th><th>Description</th></tr></thead><tbody>
<tr><td><span>Aug 26, 2026</span></td><td><div><span>Deprecated</span></div></td><td><p><a href="/api-reference/ticketing/oauth/oauth_tokens/">OAuth Tokens</a></p></td><td><p>The Create Token (<code>/api/v2/oauth/tokens</code>) endpoint is deprecated.</p></td></tr>
<tr><td><span>July 6, 2026</span></td><td><span>Breaking change</span></td><td><p><a href="/api-reference/it-asset-management/assets/">Assets API</a></p></td><td><p>Starting August 6, 2026, purchase_cost becomes an object.</p></td></tr>
<tr><td><span>Jan 5, 2026</span></td><td><span>New</span></td><td><p>Custom Queues API</p></td><td><p>New endpoints for queues.</p></td></tr>
<tr><td><span>Jan 2, 2026</span></td><td><span>Deprecated</span></td><td><p><a href="https://github.com/zendesk/spec">SunCo wrappers</a></p></td><td><p>Wrappers deprecated.</p></td></tr>
</tbody></table></main></body></html>`;

describe("parseChangelogHtml", () => {
  it("parses the Date/Event/Subject/Description table", () => {
    const e = parseChangelogHtml(CHANGELOG);
    expect(e).toHaveLength(4);
    expect(e[0]).toEqual({ date: "2026-08-26", event: "Deprecated", subject: "OAuth Tokens", subject_url: "https://developer.zendesk.com/api-reference/ticketing/oauth/oauth_tokens/", description: "The Create Token (`/api/v2/oauth/tokens`) endpoint is deprecated." });
    expect(e[2].subject_url).toBeUndefined();
  });
  it("normalises event names", () => {
    expect(normaliseEvent("Breaking change")).toBe("breaking_change");
    expect(normaliseEvent("Deprecated")).toBe("deprecated");
    expect(normaliseEvent("Removed")).toBe("removed");
    expect(normaliseEvent("New")).toBe("new");
    expect(normaliseEvent("EAP")).toBe("eap");
  });
});

describe("ChangesSource.getChanges", () => {
  const HC = "https://support.zendesk.com/api/v2/help_center";
  const mk = () => {
    const f = mockFetch({
      [DEV_CHANGELOG_URL]: { body: CHANGELOG },
      [`${HC}/en-us/sections.json`]: { json: { sections: [{ id: 4405298833818, name: "Announcements", category_id: 4405298749210 }], next_page: null } },
      [`${HC}/en-us/categories.json`]: { json: { categories: [{ id: 4405298749210, name: "Zendesk updates" }] } },
      [`${HC}/en-us/sections/4405298833818/articles.json`]: { json: { articles: [article({ id: 7, section_id: 4405298833818, title: "Announcing ticket merge enhancements", created_at: "2026-09-01T00:00:00Z", html_url: "https://support.zendesk.com/hc/en-us/articles/7", body: "<p>Rolling out now.</p>" })], next_page: null } },
      [`${HC}/en-us/sections/`]: { json: { articles: [], next_page: null } },
      [`${HC}/articles/search.json`]: { json: { results: [article({ id: 8, section_id: 4405298833818, title: "Announcing more granular OAuth client scopes", created_at: "2026-08-05T00:00:00Z", html_url: "https://support.zendesk.com/hc/en-us/articles/8", body: "<p>OAuth scopes</p>" })], count: 1, page: 1, page_count: 1, per_page: 30, next_page: null } },
    });
    const cfg = testConfig();
    const http = new HttpClient(cfg, new Logger("silent"), f, async () => {});
    const hc = new HelpCenterSource(http, cfg);
    return { f, src: new ChangesSource(http, cfg, hc) };
  };

  it("merges changelog and announcements newest-first, honouring since", async () => {
    const { src } = mk();
    const r = await src.getChanges({ since: "2026-07-01" });
    expect(r.items.map((i) => [i.date, i.feed, i.change_type])).toEqual([
      ["2026-09-01", "announcements", "new"],
      ["2026-08-26", "developer_changelog", "deprecated"],
      ["2026-07-06", "developer_changelog", "breaking_change"],
    ]);
    expect(r.items[2].effective_date).toBe("2026-08-06");
    expect(r.items[1].lifecycle.status).toBe("deprecated");
    expect(r.items[1].url).toBe("https://developer.zendesk.com/api-reference/ticketing/oauth/oauth_tokens/");
    expect(r.sources.some((s) => s.url === DEV_CHANGELOG_URL)).toBe(true);
  });
  it("filters by query across feeds", async () => {
    const { src, f } = mk();
    const r = await src.getChanges({ query: "oauth" });
    expect(r.items.map((i) => i.title)).toEqual(["Deprecated: OAuth Tokens", "Announcing more granular OAuth client scopes"]);
    expect(f.calls.some((u) => u.includes("search.json?query=oauth") && u.includes("category=4405298749210"))).toBe(true);
  });
  it("rejects an unparseable since, accepts an ISO timestamp", async () => {
    const { src } = mk();
    await expect(src.getChanges({ since: "2026-7-1" })).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect((await src.getChanges({ since: "2026-07-01T00:00:00Z" })).items).toHaveLength(3);
  });
  it("restricts feeds", async () => {
    const { src } = mk();
    const r = await src.getChanges({ feeds: ["developer_changelog"] });
    expect(r.items.every((i) => i.feed === "developer_changelog")).toBe(true);
    expect(r.items).toHaveLength(4);
  });
  it("never cites off-site changelog links as the canonical URL", async () => {
    const { src } = mk();
    const r = await src.getChanges({ query: "wrappers", feeds: ["developer_changelog"] });
    expect(r.items[0].url).toBe(DEV_CHANGELOG_URL);
    expect(r.items[0].external_link).toBe("https://github.com/zendesk/spec");
  });
});
