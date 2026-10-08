/** Shared result shapes returned by every tool. */

export type Lifecycle =
  | "current"      // documented, generally available behaviour
  | "future"       // announced/rolling out; not yet (fully) in effect
  | "beta"
  | "eap"          // early access program
  | "deprecated"   // still works, scheduled for removal
  | "legacy"       // older variant kept for compatibility
  | "retired"      // removed / end of life
  | "unknown";

export interface Source {
  kind: "help_center" | "developer_docs" | "developer_changelog" | "announcement" | "release_notes" | "developer_update" | "whats_new" | "status_api";
  url: string;            // canonical URL to cite
  title: string;
  retrieved_at: string;   // ISO time this server fetched it
  from_cache: boolean;
}

export interface LifecycleInfo {
  status: Lifecycle;
  confidence: "high" | "medium" | "low";
  scope: "whole" | "partial" | "compilation"; // partial = signal found in body only (may concern one endpoint/field); compilation = release notes listing many items
  evidence: string[];     // short phrases that drove the classification
  effective_date?: string; // ISO date the change takes/took effect, if stated
  announced_date?: string;
  rollout_end_date?: string;
  future_change_mentioned?: string; // e.g. "Starting Aug 6, 2026 ..." even when status is current
}

export interface PlanRequirement {
  product: string;         // "Suite", "Support", "Guide", ...
  plans: string[];         // ["Team","Growth","Professional","Enterprise"]
  raw: string;
}

export interface DocResult {
  title: string;
  url: string;
  content: string;              // cleaned, truncated content or snippet
  content_truncated: boolean;
  summary?: string;             // Zendesk-authored summary if present
  updated_at?: string;          // last edit per Zendesk
  created_at?: string;
  effective_date?: string;
  product?: string[];
  plan_requirements: PlanRequirement[];
  lifecycle: LifecycleInfo;
  locale?: string;
  breadcrumbs?: string[];
  headings?: string[];          // full page/article (get_* tools only)
  heading_not_found?: string;   // requested `heading` that matched nothing
  labels?: string[];
  authority: "canonical" | "changelog" | "announcement" | "status";
  source: Source;
}

export interface Conflict {
  topic: string;
  description: string;
  preferred_url: string;
  competing_urls: string[];
  rule: string;
}

export interface ToolEnvelope<T> {
  ok: true;
  tool: string;
  retrieved_at: string;
  data: T;
  citations: Source[];
  notes: string[];
  conflicts?: Conflict[];
  pagination?: { page: number; per_page: number; page_count?: number; total?: number; next_page?: number | null };
}

export interface ToolFailure {
  ok: false;
  tool: string;
  error: { code: string; message: string; details?: unknown };
}
