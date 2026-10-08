import { describe, it, expect } from "vitest";
import { StatusSource, normalise } from "../src/sources/status.js";
import { HttpClient } from "../src/util/http.js";
import { Logger } from "../src/util/log.js";
import { mockFetch, testConfig } from "./helpers.js";

// Shape copied from Zendesk's Status API reference example.
const INCIDENT = {
  data: [{ id: "247", type: "incident", attributes: { title: "Big, Bad incident", impact: "major", started_at: "2022-05-11T19:56:49.000Z", resolved_at: null, status: "investigating", outage: true, degradation: false, postmortem: "" },
    relationships: { incident_updates: { data: [{ id: "7", type: "incident_update" }] }, incident_services: { data: [{ id: "5052", type: "incident_service" }] } } }],
  included: [
    { id: "7", type: "incident_update", attributes: { description: "Investigating", created_at: "2022-05-11T19:58:13.000Z" } },
    { id: "5052", type: "incident_service", attributes: { incident_id: "247", service_id: "2", outage: true, degradation: false }, relationships: { service: { data: { id: "2", type: "service" } } } },
    { id: "2", type: "service", attributes: { name: "Ticketing", slug: "support-ticketing" } },
  ],
};

describe("normalise", () => {
  it("joins JSON:API sideloads into a flat incident view", () => {
    const v = normalise(INCIDENT as any, "incident");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: "247", title: "Big, Bad incident", impact: "major", outage: true, status: "investigating" });
    expect(v[0].services).toEqual([{ name: "Ticketing", slug: "support-ticketing", outage: true, degradation: false }]);
    expect(v[0].updates[0].description).toBe("Investigating");
  });
});

describe("StatusSource", () => {
  const S = "https://status.zendesk.com/api/incidents";
  it("reports outage with citations to both endpoints", async () => {
    const f = mockFetch({ [`${S}/active`]: { json: INCIDENT }, [`${S}/maintenance`]: { json: { data: [], included: [] } } });
    const cfg = testConfig();
    const src = new StatusSource(new HttpClient(cfg, new Logger("silent"), f, async () => {}), cfg);
    const r = await src.getStatus("acme");
    expect(r.overall).toBe("outage");
    expect(f.calls[0]).toBe(`${S}/active?subdomain=acme`);
    expect(r.sources.map((s) => s.url)).toContain(`${S}/maintenance?subdomain=acme`);
  });
  it("falls back to the global view when Zendesk rejects the subdomain (422)", async () => {
    const f = mockFetch({
      [`${S}/active?subdomain=`]: { status: 422, json: { errors: ["Invalid subdomain: nope"] } },
      [`${S}/maintenance?subdomain=`]: { status: 422, json: { errors: ["Invalid subdomain: nope"] } },
      [`${S}/active`]: { json: { data: [], included: [] } },
      [`${S}/maintenance`]: { json: { data: [], included: [] } },
    });
    const cfg = testConfig();
    const src = new StatusSource(new HttpClient(cfg, new Logger("silent"), f, async () => {}), cfg);
    const r = await src.getStatus("nope");
    expect(r.overall).toBe("operational");
    expect(r.notes[0]).toMatch(/did not recognise subdomain "nope"/);
    expect(r.notes.join(" ")).not.toMatch(/No subdomain given/);
  });
  it("rejects malformed subdomains before any request", async () => {
    const f = mockFetch({});
    const cfg = testConfig();
    const src = new StatusSource(new HttpClient(cfg, new Logger("silent"), f, async () => {}), cfg);
    await expect(src.getStatus("bad domain!")).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(f.calls).toHaveLength(0);
  });
});
