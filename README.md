# Zendesk Knowledge MCP (read-only)

A production-oriented [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant answer Zendesk questions from **live, official Zendesk sources only** — never from model memory, community posts, or third-party sites.

| Source | Used for | Access method |
| --- | --- | --- |
| `support.zendesk.com` | Product docs, plan banners, Announcements, Developer updates, Release notes, What's new | Official Help Center API (`/api/v2/help_center/…`, articles only) |
| `developer.zendesk.com` | API reference, apps framework, SDK guides, **developer changelog** | Official sitemap + live page fetch |
| `status.zendesk.com` | Active incidents, scheduled maintenance | Official Status API (`/api/incidents/…`) |

Anything else (`*.zendesk.com` tenant APIs, `www.zendesk.com`, community, GitHub, blogs) is refused at the HTTP layer, including via redirects.

## Install

Requires Node.js 20 or later on PATH. No API keys: every source is public.

**Claude Code**

```
/plugin marketplace add nightious/zendesk-knowledge-mcp
/plugin install zendesk-knowledge-mcp@zendesk-knowledge-mcp
```

This installs the MCP server and the `zendesk-knowledge` skill, which teaches the agent which tool to use and how to phrase searches.

**Codex** (CLI, IDE extension, or app)

```
codex plugin marketplace add nightious/zendesk-knowledge-mcp
```

Then run `/plugins` in Codex, install **Zendesk Knowledge**, and start a new session.

**Any other MCP client** (Claude Desktop, Cursor, …): no clone needed.

```json
{
  "mcpServers": {
    "zendesk-knowledge": {
      "command": "npx",
      "args": ["-y", "github:nightious/zendesk-knowledge-mcp"]
    }
  }
}
```

On Windows, some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "github:nightious/zendesk-knowledge-mcp"]`. Or clone the repo and point the client at `node /abs/path/dist/index.mjs`; the bundle has no runtime dependencies.

Server only, without the plugin or skill:

```bash
claude mcp add zendesk-knowledge -s user -- npx -y github:nightious/zendesk-knowledge-mcp
codex mcp add zendesk-knowledge -- npx -y github:nightious/zendesk-knowledge-mcp
```

## Tools

All tools are annotated `readOnlyHint: true`. There is deliberately **no tool that writes to Zendesk**; keep administrative actions in a separate, permission-controlled server (see [Design notes](#design-notes)).

| Tool | Purpose |
| --- | --- |
| `search_help_center(query, locale?, product?, page?, per_page?)` | Help Center Search API; returns snippets, canonical URL, updated date, product, plan requirements, lifecycle. Paginated. |
| `get_help_article(article_id_or_url, locale?)` | Full cleaned article (markdown-ish), plan banners, breadcrumbs, dates, lifecycle. |
| `search_developer_docs(query, max_results?, section?, fetch_pages?)` | Ranks developer.zendesk.com pages from the official sitemap, fetches the top hits live for title/snippet/deprecation badges. |
| `get_developer_page(url)` | Cleaned developer page with headings and lifecycle. |
| `get_zendesk_changes(query?, since?, locale?, limit?, feeds?)` | Merged feed: developer changelog + Announcements + Developer updates + Release notes + What's new. Each item has `change_type`, dates, `lifecycle`. |
| `get_zendesk_status(subdomain?)` | Live active incidents and upcoming maintenance from the Status API. |
| `get_feature_lifecycle(feature, locale?)` *(extra)* | One call to answer "is X current / beta / EAP / deprecated / retired?" across all sources, with a preferred source and conflicts. |

### Response envelope

Every tool returns JSON text:

```jsonc
{
  "ok": true,
  "tool": "search_help_center",
  "retrieved_at": "2026-09-02T20:37:49.585Z",
  "data": { ... },                    // tool-specific
  "citations": [ { "kind": "help_center", "url": "...", "title": "...", "retrieved_at": "...", "from_cache": false } ],
  "notes": [ "..." ],                 // caveats the assistant should relay
  "conflicts": [ { "topic": "...", "preferred_url": "...", "competing_urls": [...], "rule": "..." } ],
  "pagination": { "page": 1, "per_page": 10, "page_count": 334, "total": 1000, "next_page": 2 }
}
```

Errors are `{ "ok": false, "tool": "...", "error": { "code": "DOMAIN_NOT_ALLOWED" | "HTTP_ERROR" | "TIMEOUT" | "NOT_FOUND" | "RESTRICTED" | "BAD_INPUT" | "INTERNAL", "message": "..." } }` with `isError: true`.

Each document result carries:

```jsonc
{
  "title": "...", "url": "canonical https URL", "content": "cleaned text or snippet", "content_truncated": false,
  "summary": "Zendesk-authored summary if present",
  "updated_at": "2026-05-06T18:58:36Z", "created_at": "...", "effective_date": "2026-09-12",
  "product": ["Suite", "Support"],
  "plan_requirements": [ { "product": "Support", "plans": ["Team", "Professional", "Enterprise"], "raw": "Support — Team, Professional, or Enterprise" } ],
  "lifecycle": {
    "status": "current | future | beta | eap | deprecated | legacy | retired | unknown",
    "confidence": "high | medium | low",
    "scope": "whole | partial | compilation",   // partial = keyword found only in the body (may concern one endpoint); compilation = release-note digest
    "evidence": ["title: \"Deprecation\"", "rollout started 2024-07-31, ended 2026-01-12 (past)"],
    "effective_date": "...", "announced_date": "...", "rollout_end_date": "...", "future_change_mentioned": "Starting August 6, 2026 ..."
  },
  "breadcrumbs": ["Zendesk updates", "Developer updates"],
  "authority": "canonical | changelog | announcement | status",
  "source": { "kind": "help_center | developer_docs | developer_changelog | announcement | release_notes | developer_update | whats_new | status_api", ... }
}
```

## Development

```bash
git clone https://github.com/nightious/zendesk-knowledge-mcp && cd zendesk-knowledge-mcp
npm install
npm test                    # 60 unit tests, no network
npm run build               # bundles src/ into dist/index.mjs (committed; it is what installs run)
node dist/index.mjs         # stdio MCP server; logs go to stderr
```

Try it interactively with the MCP Inspector: `npm run inspect`.

### Environment variables

All optional; set them in the client's `env` block. See `.env.example`. Highlights:

| Variable | Default | Notes |
| --- | --- | --- |
| `ZD_USER_AGENT` | `zendesk-knowledge-mcp/1.0 (…)` | Identify yourself; include a contact. |
| `ZD_DEFAULT_LOCALE` | `en-us` | Help Center locale. |
| `ZD_HTTP_TIMEOUT_MS` / `ZD_HTTP_MAX_RETRIES` | `15000` / `3` | Retries only on 408/425/429/5xx/network/timeout, exponential backoff + jitter, honours `Retry-After`. |
| `ZD_RATE_*_PER_MIN` | 60 / 60 / 10 | Per-host request budget. Status API is hard-capped at 10/min per Zendesk docs. |
| `ZD_CACHE_TTL_*_S` | search 300, page 900, status 60, sitemap 3600 | **In-memory only.** Bounded by `ZD_CACHE_MAX_ENTRIES` (500). Nothing is written to disk. |
| `ZD_MAX_CONTENT_CHARS` | `12000` | Truncation limit per document (flagged in `content_truncated`). |
| `ZD_LOG_LEVEL` | `info` | JSON logs on stderr. |

No credentials are needed: every endpoint used is public. The `ZD_OAUTH_*` variables are placeholders for a future, *separate* authenticated server.

## How answers stay grounded

1. **Domain allow-list** — `HttpClient` refuses any URL that is not `https://` on one of the three official hosts, and re-validates every redirect hop. Tests cover host spoofing (`support.zendesk.com.evil.com`) and cross-host redirects.
2. **Articles only** — the Help Center *articles* search endpoint is used, so community posts never appear. Drafts are dropped.
3. **Authority ordering** — `authority: canonical > changelog > announcement`. Product docs answer *what is true now*; changelog/release notes answer *what changed and when*. `get_feature_lifecycle` and `conflicts` apply one extra rule: a newer, high-confidence deprecation/retirement notice overrides an older canonical page, because reference pages sometimes lag.
4. **Lifecycle classification** — title/label hits are strong signals; body-only hits are marked `scope: "partial"` (e.g. a reference page whose one endpoint is retired). Announcement tables ("Announced on / Rollout starts / Rollout ends") are parsed; a rollout date in the future ⇒ `future`, a completed rollout suppresses "will be…" language, and "general availability" beats EAP/beta history. Release-note digests are marked `compilation` rather than being given a single status.
5. **Citations always** — every result has a `source`, every envelope has `citations` with the retrieval time and whether it came from the short-lived cache.
6. **Honest limits** — notes tell the assistant when Zendesk's own APIs cannot answer (e.g. the Status API exposes only *active* incidents; a restricted article returns `RESTRICTED` instead of a hallucinated body; an unknown subdomain falls back to the global status view with a warning).

## Design notes

- **Read-only by construction.** No tool takes a tenant subdomain for API calls, no authenticated endpoint is touched, and the server test asserts every tool is `readOnlyHint` and none is named like a mutation. If you later need admin actions (creating triggers, updating tickets), build a *separate* server: OAuth authorization-code flow with per-scope consent, tokens stored in the OS keychain/secret manager, never in code or `.env` committed to git, and MCP tool annotations `destructiveHint: true` with client-side confirmation.
- **No bulk copy.** The only "index" is the list of URLs from `developer.zendesk.com/sitemap-index.xml` (~1,100 URLs, held for one hour). Page bodies live in a bounded LRU for at most 15 minutes.
- **Search on developer.zendesk.com** — the site has no public search API, so pages are ranked by URL-slug token overlap (with a small synonym table: `ticket→tickets`, `hc→help-center`, `sunco→sunshine-conversations`, …) and then fetched live. Use names as they appear in URLs; `other_candidate_urls` lists runners-up.
- **Locales** — `search_help_center` and `get_help_article` accept any Help Center locale (`de`, `fr`, `ja`, `pt-br`, …). The section/category taxonomy is loaded per locale and cached.
- **Concurrency** — identical in-flight requests are de-duplicated; a sliding-window limiter keeps each host under budget and *waits* rather than failing.
- **Logging** — structured JSON on stderr only, so stdout stays a clean MCP transport.

## Project layout

```
src/
  index.ts              stdio entry point
  server.ts             McpServer + tool registration + response envelopes
  config.ts             env parsing, official host list
  types.ts              DocResult / Lifecycle / Source / envelope types
  util/http.ts          allow-listed fetch: timeout, retries, rate limit, redirect check, TTL cache
  util/html.ts          HTML → markdown-ish text, plan banner extraction, snippets
  util/classify.ts      dates, lifecycle, product detection, conflict resolution, ranking
  util/{cache,rateLimiter,log,errors}.ts
  sources/helpCenter.ts   Help Center API (search, article, taxonomy, update sections)
  sources/developerDocs.ts sitemap index + page cleaning
  sources/changes.ts      developer changelog table + support.zendesk.com update feeds
  sources/status.ts       Status API (JSON:API normalisation)
test/                   vitest suites with a deterministic fetch stub (no network)
skills/                 agent skill shipped with the plugin
.claude-plugin/         Claude Code plugin + marketplace manifests
.codex-plugin/, .agents/plugins/, .mcp.json   Codex plugin + marketplace manifests
dist/index.mjs          esbuild bundle (committed)
```

## Verifying against live Zendesk

`npm test` is offline. To exercise the real endpoints, run the Inspector (`npm run inspect`) and try:

- `search_help_center` → `{ "query": "trigger conditions", "product": "Support" }`
- `get_zendesk_changes` → `{ "since": "2026-07-01" }`
- `get_feature_lifecycle` → `{ "feature": "offset pagination" }`
- `get_zendesk_status` → `{ "subdomain": "yourcompany" }`

## License

Source-available, **not open source**. Copyright (c) 2026 Nightious, all rights reserved. You may read the code and contribute through issues and pull requests to this repository; you may not copy, redistribute, or reuse it elsewhere. See [LICENSE](LICENSE).
