# Zendesk Knowledge MCP

Read-only [MCP](https://modelcontextprotocol.io) server for Zendesk docs, status, and changelogs.

| Host | Content |
| --- | --- |
| `support.zendesk.com` | Help Center articles, announcements, release notes, what's new |
| `developer.zendesk.com` | API reference, developer docs, developer changelog |
| `status.zendesk.com` | Active incidents, scheduled maintenance |

Other hosts are refused. Redirects are re-checked.

## Install

Needs Node.js 20+. No API keys.

Claude Code (server plus the `zendesk-knowledge` skill):

```
/plugin marketplace add nightious/zendesk-knowledge-mcp
/plugin install zendesk-knowledge-mcp@zendesk-knowledge-mcp
```

Codex:

```
codex plugin marketplace add nightious/zendesk-knowledge-mcp
```

Then run `/plugins`, install Zendesk Knowledge, and start a new session.

Other MCP clients:

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

On Windows, some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "github:nightious/zendesk-knowledge-mcp"]`.

Server only:

```bash
claude mcp add zendesk-knowledge -s user -- npx -y github:nightious/zendesk-knowledge-mcp
codex mcp add zendesk-knowledge -- npx -y github:nightious/zendesk-knowledge-mcp
```

## Tools

| Tool | Purpose |
| --- | --- |
| `search_help_center(query, locale?, product?, page?, per_page?)` | Search Help Center articles. Paginated. |
| `get_help_article(article_id_or_url, locale?, heading?)` | Full article with headings, plan requirements and dates. `heading` returns one section. |
| `search_developer_docs(query, max_results?, section?, fetch_pages?)` | Find developer.zendesk.com pages. |
| `get_developer_page(url, heading?)` | Full developer page with headings. `heading` or a URL `#anchor` returns one section. |
| `get_zendesk_changes(query?, since?, locale?, limit?, feeds?)` | Changelog, announcements, and release notes merged. |
| `get_zendesk_status(subdomain?)` | Active incidents and upcoming maintenance. |
| `get_feature_lifecycle(feature, locale?)` | Is a feature current, beta, EAP, deprecated, or retired. |

Each tool returns JSON with `ok`, `tool`, `data`, `citations`, `notes`, and, when relevant, `conflicts` and `pagination`. Errors return `ok: false` with `error.code`: `DOMAIN_NOT_ALLOWED`, `HTTP_ERROR`, `TIMEOUT`, `NOT_FOUND`, `RESTRICTED`, `BAD_INPUT`, or `INTERNAL`.

## Environment variables

All optional. See `.env.example`.

| Variable | Default |
| --- | --- |
| `ZD_USER_AGENT` | `zendesk-knowledge-mcp/1.0 (+https://github.com/nightious/zendesk-knowledge-mcp)` |
| `ZD_DEFAULT_LOCALE` | `en-us` |
| `ZD_HTTP_TIMEOUT_MS` | `15000` |
| `ZD_HTTP_MAX_RETRIES` | `2` |
| `ZD_RATE_{SUPPORT,DEVELOPER,STATUS}_PER_MIN` | `60` / `60` / `10` (status max 10) |
| `ZD_CACHE_TTL_{SEARCH,PAGE,STATUS,SITEMAP}_S` | `300` / `900` / `60` / `3600` |
| `ZD_CACHE_MAX_ENTRIES` | `500` (in-memory) |
| `ZD_MAX_CONTENT_CHARS` | `12000` |
| `ZD_LOG_LEVEL` | `info` (`silent`, `error`, `info`, `debug`; stderr) |

## Development

```bash
git clone https://github.com/nightious/zendesk-knowledge-mcp && cd zendesk-knowledge-mcp
npm install
npm test
npm run build    # writes dist/index.mjs, which is committed
npm run inspect  # MCP Inspector
```

## License

Source-available, not open source. You may install and run it; you may not redistribute or modify it. See [LICENSE](LICENSE).
