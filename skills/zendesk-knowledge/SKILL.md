---
name: zendesk-knowledge
description: 'Answer Zendesk questions from live official Zendesk docs via the zendesk-knowledge MCP. Load this before the first zendesk-knowledge tool call: it has the query rules that make search find the right article. Use whenever the user asks about Zendesk (features, plans, admin setup, triggers, automations, SLAs, routing, APIs, deprecations, what''s new, outages), even if they don''t say "search". Never answer Zendesk questions from memory.'
---

# zendesk-knowledge

Always search, then open the best hit, then answer with its URL. Even when you think you know the answer.

## Pick the tool

| Ask | Tool |
| --- | --- |
| How a feature works, plans, admin setup | `search_help_center` → `get_help_article` |
| API endpoint, field, limits, apps | `search_developer_docs` → `get_developer_page` |
| Is X deprecated / beta / going away? | `get_feature_lifecycle`; for APIs also `get_zendesk_changes` with `feeds:["developer_changelog"]` |
| What changed since a date | `get_zendesk_changes` (`since`) |
| Outage now | `get_zendesk_status` |

## Write the query

Search is keyword-ranked: the user's sentence buries the right article, Zendesk's feature name finds it.

1. **Translate the goal into the Zendesk feature name and search only that** (1–3 words). Don't append the user's words.
   "send Spanish tickets to Spanish speakers" → `skills-based routing` (not `skills-based routing language agents speak`) ·
   "stop the SLA clock while we wait on the customer" → `pause SLA` · "a 'Waiting on vendor' status" → `custom ticket statuses` · "try changes safely" → `sandbox`.
2. **Use current names:** AI agents (not Answer Bot), messaging (not Chat, unless legacy), omnichannel routing, agent workspace.
3. **One concept per query.** No plan names or qualifiers (`premium sandbox` returns junk); the article's plan banner answers plan questions.
4. **API: search the resource as named in the URL slug** (`ticket audits`, `webhooks`, `tickets`). Actions aren't slugs: for "merge tickets" open the Tickets page and re-call with `heading` from its `headings`. Shared names need the product area: `business rules triggers` vs `chat api triggers`.
5. **Miss?** Drop words → try another name for the feature → switch search tool. After 3 rewrites, say nothing was found.

Quotes and `product` don't filter; ignore `total`. Judge hits by title and `breadcrumbs`. Non-English: pass `locale` (e.g. `de`).

## Answer

- **Open the top 1–2 hits with `get_help_article` / `get_developer_page` before answering.** Snippets miss plan limits and caveats. Pass `heading` for one section of a long page.
- Cite the URLs you opened. Relay `notes` and `plan_requirements`.
- Lifecycle: trust `scope:"whole"` + `confidence:"high"`. A `current` verdict doesn't rule out a breaking change in the changelog.
- `RESTRICTED` = sign-in required; give the URL, don't paraphrase. Status shows active incidents only.
- Never fill gaps from memory; label anything from outside these tools as unofficial.
