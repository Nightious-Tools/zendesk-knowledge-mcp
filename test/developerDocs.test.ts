import { describe, it, expect } from "vitest";
import { DeveloperDocsSource, tokenize } from "../src/sources/developerDocs.js";
import { HttpClient } from "../src/util/http.js";
import { Logger } from "../src/util/log.js";
import { mockFetch, testConfig } from "./helpers.js";

const D = "https://developer.zendesk.com";
const page = (title: string, body: string) => `<html><head><title>${title} | Zendesk Developer Docs</title></head><body><nav>nav</nav><main><div class="Breadcrumb">crumbs</div><h1>${title}</h1><div><h2>On this page</h2><a href="#a">A</a></div>${body}<div class="Footer">footer</div></main></body></html>`;

const mk = () => {
  const f = mockFetch({
    [`${D}/sitemap-index.xml`]: { body: `<sitemapindex><sitemap><loc>${D}/sitemap-0.xml</loc></sitemap></sitemapindex>` },
    [`${D}/sitemap-0.xml`]: { body: `<urlset><url><loc>${D}/api-reference/ticketing/oauth/oauth_tokens/</loc></url><url><loc>${D}/api-reference/live-chat/chat-api/oauth_tokens/</loc></url><url><loc>${D}/documentation/ticketing/managing-tickets/creating-and-updating-tickets/</loc></url><url><loc>https://evil.com/x</loc></url></urlset>` },
    [`${D}/api-reference/ticketing/oauth/oauth_tokens/`]: { body: page("OAuth Tokens", "<p><strong>Note</strong>: The Create Token endpoint is no longer available. Use Create Token for Grant Type instead.</p><h2>List Tokens</h2><p>GET /api/v2/oauth/tokens</p>") },
    [`${D}/api-reference/live-chat/chat-api/oauth_tokens/`]: { body: page("OAuth Tokens", "<p>List and revoke Chat OAuth tokens.</p>") },
    [`${D}/documentation/ticketing/managing-tickets/creating-and-updating-tickets/`]: { body: page("Creating and updating tickets", "<p>Use the Tickets API.</p>") },
  });
  const cfg = testConfig();
  return { f, dev: new DeveloperDocsSource(new HttpClient(cfg, new Logger("silent"), f, async () => {}), cfg) };
};

describe("DeveloperDocsSource", () => {
  it("tokenizes with synonyms", () => {
    expect(tokenize("OAuth token")).toEqual(expect.arrayContaining(["oauth", "token", "tokens"]));
  });
  it("indexes only official sitemap URLs and ranks by slug", async () => {
    const { dev } = mk();
    const entries = await dev.loadIndex();
    expect(entries.map((e) => e.url).some((u) => u.includes("evil.com"))).toBe(false);
    const r = await dev.search("oauth tokens", { maxResults: 2 });
    expect(r.results.map((x) => x.url)).toEqual([`${D}/api-reference/ticketing/oauth/oauth_tokens/`, `${D}/api-reference/live-chat/chat-api/oauth_tokens/`]);
    expect(r.results[0].lifecycle).toMatchObject({ status: "retired", scope: "partial" });
    expect(r.results[1].lifecycle.status).toBe("current");
    expect(r.results[0].source.kind).toBe("developer_docs");
  });
  it("section filter and fetch_pages=false", async () => {
    const { dev, f } = mk();
    const before = f.calls.length;
    const r = await dev.search("tickets", { section: "documentation", fetchPages: false });
    expect(r.results.map((x) => x.url)).toEqual([`${D}/documentation/ticketing/managing-tickets/creating-and-updating-tickets/`]);
    expect(r.results[0].lifecycle.status).toBe("unknown");
    expect(f.calls.length - before).toBe(2); // only the two sitemap fetches
  });
  it("getPage cleans navigation/TOC and canonicalises the URL", async () => {
    const { dev } = mk();
    const d = await dev.getPage(`${D}/api-reference/ticketing/oauth/oauth_tokens#list-tokens`);
    expect(d.url).toBe(`${D}/api-reference/ticketing/oauth/oauth_tokens/`);
    expect(d.title).toBe("OAuth Tokens");
    expect(d.content).not.toContain("crumbs");
    expect(d.content).not.toContain("On this page");
    expect(d.content).toContain("## List Tokens");
    expect(d.breadcrumbs).toEqual(["Api Reference", "Ticketing", "Oauth"]);
  });
  it("refuses non-developer hosts", async () => {
    const { dev } = mk();
    await expect(dev.getPage("https://support.zendesk.com/hc/en-us/articles/1")).rejects.toMatchObject({ code: "DOMAIN_NOT_ALLOWED" });
  });
});
