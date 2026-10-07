import { describe, it, expect } from "vitest";
import { HttpClient, isOfficialUrl } from "../src/util/http.js";
import { DomainNotAllowedError, HttpError, TimeoutError } from "../src/util/errors.js";
import { Logger } from "../src/util/log.js";
import { mockFetch, testConfig } from "./helpers.js";

const noSleep = async () => {};
const mk = (routes: Parameters<typeof mockFetch>[0], cfg = testConfig()) => {
  const f = mockFetch(routes);
  return { f, http: new HttpClient(cfg, new Logger("silent"), f, noSleep) };
};

describe("domain allow-list", () => {
  it("accepts only https on official hosts", () => {
    expect(isOfficialUrl("https://support.zendesk.com/hc/en-us")).toBe(true);
    expect(isOfficialUrl("https://developer.zendesk.com/api-reference/")).toBe(true);
    expect(isOfficialUrl("https://status.zendesk.com/api/incidents/active")).toBe(true);
    expect(isOfficialUrl("http://support.zendesk.com/")).toBe(false);
    expect(isOfficialUrl("https://acme.zendesk.com/api/v2/tickets")).toBe(false);
    expect(isOfficialUrl("https://support.zendesk.com.evil.com/")).toBe(false);
    expect(isOfficialUrl("https://www.zendesk.com/blog")).toBe(false);
    expect(isOfficialUrl("https://community.zendesk.com/")).toBe(false);
    expect(isOfficialUrl("not a url")).toBe(false);
  });
  it("refuses to fetch non-official URLs without touching the network", async () => {
    const { f, http } = mk({});
    await expect(http.get("https://example.com/")).rejects.toBeInstanceOf(DomainNotAllowedError);
    expect(f.calls).toHaveLength(0);
  });
  it("refuses redirects that leave official hosts", async () => {
    const { http } = mk({ "https://support.zendesk.com/x": { status: 302, headers: { location: "https://evil.com/" } } });
    await expect(http.get("https://support.zendesk.com/x")).rejects.toBeInstanceOf(DomainNotAllowedError);
  });
  it("follows redirects within official hosts", async () => {
    const { http } = mk({
      "https://support.zendesk.com/old": { status: 301, headers: { location: "/new" } },
      "https://support.zendesk.com/new": { body: "hello" },
    });
    const r = await http.get("https://support.zendesk.com/old");
    expect(r.body).toBe("hello");
    expect(r.url).toBe("https://support.zendesk.com/new");
  });
});

describe("resilience", () => {
  it("retries on 503 then succeeds", async () => {
    const { f, http } = mk({ "https://support.zendesk.com/a": [{ status: 503 }, { status: 503 }, { body: "ok" }] });
    const r = await http.get("https://support.zendesk.com/a");
    expect(r.body).toBe("ok");
    expect(f.calls).toHaveLength(3);
  });
  it("honours Retry-After on 429 and gives up after maxRetries", async () => {
    const { f, http } = mk({ "https://support.zendesk.com/b": { status: 429, headers: { "retry-after": "1" } } });
    await expect(http.get("https://support.zendesk.com/b")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(3); // 1 + 2 retries
  });
  it("does not retry 404", async () => {
    const { f, http } = mk({ "https://support.zendesk.com/c": { status: 404 } });
    await expect(http.get("https://support.zendesk.com/c")).rejects.toMatchObject({ status: 404 });
    expect(f.calls).toHaveLength(1);
  });
  it("times out", async () => {
    const cfg = testConfig({ timeoutMs: 20, maxRetries: 0 });
    const slow: any = (_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
    const http = new HttpClient(cfg, new Logger("silent"), slow, noSleep);
    await expect(http.get("https://support.zendesk.com/slow")).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("cache", () => {
  it("serves repeat requests from the short-lived cache and marks them", async () => {
    const { f, http } = mk({ "https://support.zendesk.com/d": { body: "v1" } });
    const a = await http.get("https://support.zendesk.com/d", { ttlMs: 60_000 });
    const b = await http.get("https://support.zendesk.com/d", { ttlMs: 60_000 });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(f.calls).toHaveLength(1);
    http.clearCache();
    await http.get("https://support.zendesk.com/d", { ttlMs: 60_000 });
    expect(f.calls).toHaveLength(2);
  });
  it("ttl 0 bypasses the cache", async () => {
    const { f, http } = mk({ "https://support.zendesk.com/e": { body: "v" } });
    await http.get("https://support.zendesk.com/e", { ttlMs: 0 });
    await http.get("https://support.zendesk.com/e", { ttlMs: 0 });
    expect(f.calls).toHaveLength(2);
  });
});
