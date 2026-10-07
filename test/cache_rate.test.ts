import { describe, it, expect } from "vitest";
import { TtlCache } from "../src/util/cache.js";
import { RateLimiter } from "../src/util/rateLimiter.js";

describe("TtlCache", () => {
  it("expires entries and evicts LRU", () => {
    let now = 0;
    const c = new TtlCache<string>(2, () => now);
    c.set("a", "1", 100); c.set("b", "2", 100);
    expect(c.get("a")).toBe("1");
    c.set("c", "3", 100);            // evicts "b" (a was touched)
    expect(c.get("b")).toBeUndefined();
    now = 101;
    expect(c.get("a")).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("waits once the per-minute budget is used", async () => {
    let now = 0; const sleeps: number[] = [];
    const rl = new RateLimiter({ "status.zendesk.com": 2 }, 60_000, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    await rl.acquire("status.zendesk.com"); await rl.acquire("status.zendesk.com");
    await rl.acquire("status.zendesk.com");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
    await rl.acquire("other.host");     // unlimited keys never wait
    expect(sleeps.length).toBe(1);
  });
});
