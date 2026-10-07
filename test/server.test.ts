import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, consolidate } from "../src/server.js";
import { article, mockFetch, testConfig } from "./helpers.js";
import type { DocResult } from "../src/types.js";

const HC = "https://support.zendesk.com/api/v2/help_center";

async function connect(routes: Record<string, any>) {
  const f = mockFetch(routes);
  const { server } = createServer({ cfg: testConfig(), fetchImpl: f });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { raw: r, json: JSON.parse(r.content[0].text) };
  };
  return { client, server, f, call, close: async () => { await client.close(); await server.close(); } };
}

describe("MCP server", () => {
  it("exposes exactly the read-only tool set", async () => {
    const c = await connect({});
    const tools = (await c.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["get_developer_page", "get_feature_lifecycle", "get_help_article", "get_zendesk_changes", "get_zendesk_status", "search_developer_docs", "search_help_center"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.name).not.toMatch(/create|update|delete|set|post|write/);
    }
    await c.close();
  });

  it("returns an envelope with citations for search_help_center", async () => {
    const c = await connect({
      [`${HC}/articles/search.json`]: { json: { results: [article()], count: 1, page: 1, page_count: 1, per_page: 10, next_page: null } },
      [`${HC}/en-us/sections.json`]: { json: { sections: [], next_page: null } },
      [`${HC}/en-us/categories.json`]: { json: { categories: [] } },
    });
    const { json } = await c.call("search_help_center", { query: "trigger conditions" });
    expect(json.ok).toBe(true);
    expect(json.tool).toBe("search_help_center");
    expect(json.citations).toHaveLength(1);
    expect(json.citations[0].url).toMatch(/^https:\/\/support\.zendesk\.com\//);
    expect(json.data.results[0].plan_requirements).toHaveLength(2);
    expect(json.pagination.total).toBe(1);
    await c.close();
  });

  it("validates input and refuses non-official URLs as a structured error", async () => {
    const c = await connect({});
    const { raw, json } = await c.call("get_developer_page", { url: "https://evil.com/docs" });
    expect(raw.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("DOMAIN_NOT_ALLOWED");
    expect(c.f.calls).toHaveLength(0);
    const bad: any = await c.client.callTool({ name: "get_help_article", arguments: {} });
    expect(bad.isError).toBe(true); // zod rejects missing article_id_or_url
    await c.close();
  });

  it("status tool returns overall state + citations", async () => {
    const c = await connect({
      "https://status.zendesk.com/api/incidents/active": { json: { data: [], included: [] } },
      "https://status.zendesk.com/api/incidents/maintenance": { json: { data: [], included: [] } },
    });
    const { json } = await c.call("get_zendesk_status", {});
    expect(json.data.overall).toBe("operational");
    expect(json.citations.map((x: any) => x.url)).toContain("https://status.zendesk.com");
    await c.close();
  });
});

describe("consolidate", () => {
  const doc = (o: Partial<DocResult>): DocResult => ({
    title: "x", url: "u", content: "", content_truncated: false, plan_requirements: [], authority: "canonical",
    lifecycle: { status: "current", confidence: "high", scope: "whole", evidence: [] },
    source: { kind: "help_center", url: "u", title: "x", retrieved_at: "", from_cache: false }, ...o,
  });
  it("ignores irrelevant docs and lets explicit deprecation notices win", () => {
    const v = consolidate("offset pagination", [
      doc({ title: "Using Airtable actions", content: "offset pagination mentioned once", url: "a", updated_at: "2026-06-18" }),
      doc({ title: "Paginating through lists using offset pagination", url: "b", authority: "canonical" }),
      doc({ title: "Deprecated: offset pagination beyond 100 pages", url: "c", authority: "changelog", lifecycle: { status: "deprecated", confidence: "high", scope: "whole", evidence: ["changelog event tag: Deprecated"] } }),
    ]);
    expect(v.preferred_source).toBe("c");
    expect(v.status).toBe("deprecated");
    expect((v as any).considered.map((x: any) => x.url)).not.toContain("a");
  });
  it("returns unknown when nothing matches", () => {
    expect(consolidate("zzz", [doc({ title: "Unrelated" })]).status).toBe("unknown");
  });
});
