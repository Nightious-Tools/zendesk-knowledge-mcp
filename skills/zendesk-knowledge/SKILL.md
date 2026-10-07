---
name: zendesk-knowledge
description: Answer Zendesk questions with the zendesk-knowledge MCP (read-only, live official Zendesk sources). Use whenever the user asks about Zendesk — features, plans, admin setup, triggers/automations/SLAs/routing, APIs, deprecations, what's new, outages, or restructuring a Zendesk instance — even if they don't say "search". Never answer Zendesk questions from memory when this MCP is available.
---

# zendesk-knowledge

Seven read-only tools. Every response has `citations`, `notes`, and per-result `lifecycle`. Cite the returned URLs; relay `notes` when they limit the answer.

## Which tool

| Need | Tool |
| --- | --- |
| Feature behaviour, plans, admin how-to | `search_help_center` → `get_help_article` |
| API endpoint, field, apps framework | `search_developer_docs` → `get_developer_page` |
| What changed / deprecated since a date | `get_zendesk_changes` |
| Is X current / beta / EAP / deprecated / retired? | `get_feature_lifecycle` |
| Outage or maintenance right now | `get_zendesk_status` (`subdomain` for the account) |

Always open the best hit before stating specifics — search results are snippets.

## Searching the Help Center (tested)

- **Use Zendesk's own product nouns, 2–4 words.** "skills-based routing", "messaging triggers", "custom ticket statuses" hit the canonical article first. Full sentences ("how do I make an SLA policy pause when…") bury it under FAQ noise.
- **Current names beat old ones:** AI agents (not Answer Bot), messaging (not chat) unless the user is on legacy Chat, omnichannel routing, agent workspace.
- **Short FAQ-style questions work** because Zendesk has Q&A articles: "can I pause the SLA timer", "can agents see tickets from other groups".
- **Start broad, then narrow.** "sandbox" → good; "premium sandbox" → compliance/what's-new junk. Adding qualifiers can hurt.
- `product` only re-ranks; it doesn't filter. Judge relevance from `breadcrumbs` and `plan_requirements`.
- `total` caps at 1000; that number means nothing. Look at the top 3–5 titles; paginate only if they miss.
- Non-English: `locale:"de"` etc.

## Searching developer docs (tested)

- Ranking is by URL slug, so use **resource names**: `ticket audits`, `webhooks`, `custom objects records`, `sla policies`, `user fields`, `job status`.
- **Disambiguate shared names with the product area**, because Chat, Ticketing and Custom Data each have e.g. triggers/search/rate limits: "business rules triggers", "chat api triggers", "ticketing search", "custom objects limits". `section:"api-reference"` alone does not disambiguate.
- **Actions aren't in slugs.** "merge tickets", "bulk update", "create ticket" all resolve to the Tickets page — open it with `get_developer_page` and find the endpoint in the headings.
- Concept questions ("authenticate with API token") land in `/documentation/authentication/…`; use `section:"documentation"` for guides.
- `other_candidate_urls` lists runners-up; `fetch_pages:false` is a fast preview.

## Changes and lifecycle (tested)

- API deprecations/breaking changes: `get_zendesk_changes` with `feeds:["developer_changelog"]` — clean, tagged, dated. Query words like "deprecated" match the changelog well.
- Product announcements: keyword matching against `announcements`/`release_notes` is loose (Zendesk's search); verify titles, and exclude `release_notes` via `feeds` when you want specific announcements rather than weekly digests.
- `since` accepts ISO or "Aug 1, 2026".
- `get_feature_lifecycle` verdicts: trust `scope:"whole"` + `confidence:"high"`. When `scope:"partial"`, the keyword came from the body (e.g. "Agent Workspace" page mentioning the *legacy* interface it replaced) — open `preferred_source` before concluding anything is legacy/deprecated. `compilation` = digest; open the specific item.
- `lifecycle.status` meanings: `current` GA · `future` announced, quote `effective_date` · `beta`/`eap` limited · `deprecated`/`legacy` works but superseded · `retired` gone.
- `authority`: `canonical` = what is true now; `changelog`/`announcement` = what changed and when. Name the preferred URL if `conflicts` appears.
- `external_link` on a change item (GitHub, zopim.com) is Zendesk's own pointer but not an official doc — say so if you use it.

## Rules

- Nothing from the tools → say so and try a different phrasing; never fill in from training data.
- `RESTRICTED` = article needs Zendesk sign-in; give the URL, don't paraphrase it.
- Status API shows only *active* incidents; "operational" ≠ nothing happened earlier.
- Web search outside the MCP is not official; label it.
- This MCP cannot modify any Zendesk account.
