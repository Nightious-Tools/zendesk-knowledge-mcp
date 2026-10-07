import { describe, it, expect } from "vitest";
import { parseDate, extractAnnouncementDates, classifyLifecycle, detectProducts, detectConflicts, topicKey } from "../src/util/classify.js";
import type { DocResult } from "../src/types.js";

const today = new Date("2026-09-02T00:00:00Z");

describe("dates", () => {
  it("parses common formats", () => {
    expect(parseDate("Aug 26, 2026")).toBe("2026-08-26");
    expect(parseDate("July 6th, 2026")).toBe("2026-07-06");
    expect(parseDate("6 August 2026")).toBe("2026-08-06");
    expect(parseDate("2026-01-12")).toBe("2026-01-12");
    expect(parseDate("no date here")).toBeUndefined();
  });
  it("reads announcement tables rendered as markdown", () => {
    const d = extractAnnouncementDates("| Announced on | Rollout starts | Rollout ends |\n| --- | --- | --- |\n| July 1, 2024 | July 31, 2024 | January 12, 2026 |\n\nBody");
    expect(d).toEqual({ announced: "2024-07-01", rolloutStart: "2024-07-31", rolloutEnd: "2026-01-12" });
  });
  it("reads inline announcement labels", () => {
    const d = extractAnnouncementDates("Announced on: March 2, 2023. New API rollout on March 2, 2023. Old API deprecated on September 1, 2023.");
    expect(d.announced).toBe("2023-03-02");
    expect(d.rolloutEnd).toBe("2023-09-01");
  });
});

describe("lifecycle classification", () => {
  it("plain product doc is current", () => {
    const l = classifyLifecycle({ title: "Creating ticket triggers", text: "Triggers run when a ticket is created.", today });
    expect(l.status).toBe("current");
    expect(l.scope).toBe("whole");
  });
  it("deprecation announcement with completed rollout is deprecated, not future", () => {
    const l = classifyLifecycle({ title: "Deprecation of password access for APIs", text: "| Announced on | Rollout starts | Rollout ends |\n| --- | --- | --- |\n| July 1, 2024 | July 31, 2024 | January 12, 2026 |\n\nIt will be turned off on January 12, 2026.", today });
    expect(l.status).toBe("deprecated");
    expect(l.confidence).toBe("high");
    expect(l.effective_date).toBe("2024-07-31");
    expect(l.rollout_end_date).toBe("2026-01-12");
  });
  it("announcement with a future rollout date is future", () => {
    const l = classifyLifecycle({ title: "Announcing the Universal Connector", text: "| Announced on | Rollout starts |\n| --- | --- |\n| September 2, 2026 | September 12, 2026 |\n\nGeneral availability for all customers.", today });
    expect(l.status).toBe("future");
    expect(l.effective_date).toBe("2026-09-12");
  });
  it("GA announcement beats EAP history in the body", () => {
    const l = classifyLifecycle({ title: "Announcing the general availability of multi-recipient email tickets", text: "This feature was previously in an early access program (EAP). It is now generally available.", today });
    expect(l.status).toBe("current");
  });
  it("EAP / beta / legacy / retired from title", () => {
    expect(classifyLifecycle({ title: "Employee service AI agents (EAP)", text: "", today }).status).toBe("eap");
    expect(classifyLifecycle({ title: "Using the beta reporting builder", text: "", today }).status).toBe("beta");
    expect(classifyLifecycle({ title: "Legacy custom object events", text: "", today }).status).toBe("legacy");
    expect(classifyLifecycle({ title: "Chat widget end of life", text: "", today }).status).toBe("retired");
  });
  it("body-only deprecation note on a reference page is partial scope", () => {
    const l = classifyLifecycle({ title: "OAuth Tokens", text: "OAuth tokens authenticate requests. Note: The Create Token endpoint is no longer available. Use Create Token for Grant Type instead.", today });
    expect(l.status).toBe("retired");
    expect(l.scope).toBe("partial");
    expect(l.confidence).toBe("medium");
  });
  it("future-dated 'Starting ...' sentence marks a future change", () => {
    const l = classifyLifecycle({ title: "Assets API", text: "Starting August 6, 2027, the purchase_cost field will change to an object.", today });
    expect(l.status).toBe("future");
    expect(l.future_change_mentioned).toContain("Starting August 6, 2027");
  });
  it("release-note digests are flagged as compilations", () => {
    const l = classifyLifecycle({ title: "Release notes through 2026-08-28", text: "Beta: X. EAP: Y. Deprecated: Z.", compilation: true, today });
    expect(l.scope).toBe("compilation");
    expect(l.status).toBe("current");
  });
});

describe("products & conflicts", () => {
  it("detects products from labels, breadcrumbs and banners", () => {
    expect(detectProducts("Trigger conditions", ["support"], ["Product guides", "Business rules"], ["All Suites"])).toEqual(expect.arrayContaining(["Suite", "Support"]));
    expect(detectProducts("Using OAuth for the API")).toContain("Apps & API");
  });
  it("topic keys normalise titles", () => {
    expect(topicKey("Announcing the deprecation of Foo Bar")).toBe(topicKey("Foo Bar deprecation announced"));
  });
  it("prefers a newer deprecation notice over an older canonical page", () => {
    const base = (o: Partial<DocResult>): DocResult => ({
      title: "Offset pagination", url: "u", content: "", content_truncated: false, plan_requirements: [],
      lifecycle: { status: "current", confidence: "high", scope: "whole", evidence: [] }, authority: "canonical",
      source: { kind: "help_center", url: "u", title: "t", retrieved_at: "", from_cache: false }, ...o,
    });
    const docs = [
      base({ url: "https://d/canonical", updated_at: "2025-01-01" }),
      base({ url: "https://d/notice", authority: "announcement", updated_at: "2026-06-01", lifecycle: { status: "deprecated", confidence: "high", scope: "whole", evidence: [] } }),
    ];
    const c = detectConflicts(docs);
    expect(c).toHaveLength(1);
    expect(c[0].preferred_url).toBe("https://d/notice");
    // same statuses -> no conflict
    expect(detectConflicts([docs[0], base({ url: "https://d/x" })])).toHaveLength(0);
  });
});
