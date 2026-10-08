import { OFFICIAL_HOSTS, type Config } from "../config.js";
import type { HttpClient } from "../util/http.js";
import { HttpError, ZdError } from "../util/errors.js";
import type { Source } from "../types.js";

const BASE = `https://${OFFICIAL_HOSTS.status}`;

interface JsonApiResource { id: string; type: string; attributes: Record<string, any>; relationships?: Record<string, { data: { id: string; type: string }[] | { id: string; type: string } }> }
interface StatusResponse { data: JsonApiResource[] | JsonApiResource; included?: JsonApiResource[] }

export interface IncidentView {
  id: string;
  title: string;
  kind: "incident" | "maintenance";
  impact?: string;
  status?: string;
  outage?: boolean;
  degradation?: boolean;
  started_at?: string;
  resolved_at?: string | null;
  maintenance_start_time?: string;
  maintenance_end_time?: string | null;
  maintenance_article?: string;
  postmortem?: string;
  services: { name: string; slug: string; outage?: boolean; degradation?: boolean }[];
  updates: { created_at: string; description: string }[];
  url: string;
}

/**
 * Official Zendesk Status API (public, no auth, 10 req/min).
 * Limitation documented by Zendesk: only *active* incidents and *upcoming*
 * maintenance are exposed; resolved/historical incidents are not available.
 */
export class StatusSource {
  constructor(private http: HttpClient, private cfg: Config) {}

  async getStatus(subdomain?: string): Promise<{ active: IncidentView[]; maintenance: IncidentView[]; overall: "operational" | "degraded" | "outage" | "maintenance_scheduled"; sources: Source[]; notes: string[] }> {
    const sub = subdomain?.trim().toLowerCase();
    if (sub && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) throw new ZdError(`Invalid subdomain "${subdomain}"`, "BAD_INPUT");
    let qs = sub ? `?subdomain=${encodeURIComponent(sub)}` : "";
    const ttl = this.cfg.cacheTtlS.status * 1000;
    const extraNotes: string[] = [];
    const load = (q: string) => Promise.all([
      this.http.getJson<StatusResponse>(`${BASE}/api/incidents/active${q}`, ttl),
      this.http.getJson<StatusResponse>(`${BASE}/api/incidents/maintenance${q}`, ttl),
    ]);
    let active, maint;
    try {
      [active, maint] = await load(qs);
    } catch (e) {
      // Zendesk answers 422 "Invalid subdomain" for unknown accounts: fall back to the global view rather than fail.
      if (sub && e instanceof HttpError && e.status === 422) {
        extraNotes.push(`Zendesk's Status API did not recognise subdomain "${sub}" (${e.bodySnippet ?? "422"}); showing all active incidents instead. Check the subdomain spelling.`);
        qs = "";
        [active, maint] = await load(qs);
      } else throw e;
    }
    const activeViews = normalise(active.data, "incident");
    const maintViews = normalise(maint.data, "maintenance");
    const overall = activeViews.some((i) => i.outage) ? "outage" : activeViews.length ? "degraded" : maintViews.length ? "maintenance_scheduled" : "operational";
    const notes = [
      ...extraNotes,
      "Zendesk's Status API returns only currently active incidents and upcoming maintenance; resolved or historical incidents are not available via API (see status.zendesk.com for history).",
      sub ? (qs ? `Filtered to incidents Zendesk associates with subdomain "${sub}". Absence of incidents does not guarantee the account is unaffected by a very new event.` : "") : "No subdomain given: showing all active incidents across Zendesk infrastructure.",
    ].filter(Boolean);
    return {
      active: activeViews,
      maintenance: maintViews,
      overall,
      sources: [
        { kind: "status_api", url: `${BASE}/api/incidents/active${qs}`, title: "Zendesk Status API — active incidents", retrieved_at: active.meta.retrievedAt, from_cache: active.meta.cached },
        { kind: "status_api", url: `${BASE}/api/incidents/maintenance${qs}`, title: "Zendesk Status API — scheduled maintenance", retrieved_at: maint.meta.retrievedAt, from_cache: maint.meta.cached },
        { kind: "status_api", url: BASE, title: "Zendesk System Status page", retrieved_at: active.meta.retrievedAt, from_cache: active.meta.cached },
      ],
      notes,
    };
  }
}

export function normalise(res: StatusResponse, kind: IncidentView["kind"]): IncidentView[] {
  const data = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  const inc = new Map<string, JsonApiResource>();
  for (const r of res.included ?? []) inc.set(`${r.type}:${r.id}`, r);
  return data.map((d) => {
    const a = d.attributes ?? {};
    const rel = (name: string) => {
      const x = d.relationships?.[name]?.data;
      return Array.isArray(x) ? x : x ? [x] : [];
    };
    const updates = rel("incident_updates").map((u) => inc.get(`incident_update:${u.id}`)).filter(Boolean)
      .map((u) => ({ created_at: u!.attributes.created_at, description: u!.attributes.description }))
      .sort((x, y) => (y.created_at ?? "").localeCompare(x.created_at ?? ""));
    const services = rel("incident_services").map((s) => inc.get(`incident_service:${s.id}`)).filter(Boolean).map((is) => {
      const sref = (is!.relationships?.service?.data as { id: string } | undefined)?.id ?? is!.attributes.service_id;
      const svc = inc.get(`service:${sref}`);
      return { name: svc?.attributes.name ?? `service ${sref}`, slug: svc?.attributes.slug ?? "", outage: is!.attributes.outage, degradation: is!.attributes.degradation };
    });
    return {
      id: d.id,
      title: a.title,
      kind,
      impact: a.impact,
      status: a.status,
      outage: a.outage,
      degradation: a.degradation,
      started_at: a.started_at,
      resolved_at: a.resolved_at,
      maintenance_start_time: a.maintenance_start_time,
      maintenance_end_time: a.maintenance_end_time,
      maintenance_article: a.maintenance_article || undefined,
      postmortem: a.postmortem || undefined,
      services,
      updates,
      url: `${BASE}/`,
    };
  });
}
