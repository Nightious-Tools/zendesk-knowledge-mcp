# zendesk-knowledge-mcp

Read-only MCP stdio server over support/developer/status.zendesk.com. `src/server.ts` registers the 7 tools.

## Rules

- `src/util/http.ts`: https allow-listed hosts only, rechecked per redirect. Keep strict.
- Help Center: articles endpoints only, no community.
- Authority: canonical > changelog > announcement. A newer deprecation notice beats an older canonical page; in `get_feature_lifecycle` a high-confidence whole-page deprecation wins.
- Lifecycle scope `partial` (body-only hit) and `compilation` (release-note digest) are not page-wide statuses.
- Cache is in-memory only; nothing on disk.
- Logs to stderr only; stdout is the MCP transport.
- No write tools. `test/server.test.ts` asserts `readOnlyHint`.

## dist/ is what runs

Installs run the committed `dist/index.mjs`, no `npm install`, so runtime deps are devDependencies. After any `src/` edit, `npm run build` and commit `dist/` with it; CI fails on a stale bundle. Keep the build script's `createRequire` banner (cheerio's CJS deps call `require`).

## Plugin hosts

Claude Code: `.claude-plugin/`. Codex: `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `.mcp.json`. Both: `skills/zendesk-knowledge/SKILL.md`.

Codex doesn't expand `${CLAUDE_PLUGIN_ROOT}`, so `.mcp.json` uses a relative path + `"cwd": "."`. Claude Code also loads `.mcp.json`; the inline server in `.claude-plugin/plugin.json` has the same name (`zendesk-knowledge`) so it overrides it.

## Lockstep

| Change | Also update |
|---|---|
| version | `package.json`, `SERVER_VERSION` in `src/server.ts`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` (CI checks) |
| a tool or param | `src/server.ts`, `README.md`, `SKILL.md` |
| plugin name `zendesk-knowledge-mcp` | `package.json`, both `marketplace.json`, both `plugin.json`, README |
| server name `zendesk-knowledge` | `SERVER_NAME`, `.mcp.json`, `.claude-plugin/plugin.json`, README |

## Releasing

Bump version first.

```
npm run typecheck && npm test && npm run build
git commit -am vX.Y.Z && git push
gh release create vX.Y.Z --title vX.Y.Z --notes "..."
```

As GitHub user `nightious` (`gh auth switch -u nightious`).

## Verification

`npm test` is offline. Bundle: copy `dist/index.mjs` alone to an empty dir, pipe `initialize` + `tools/list` into `node index.mjs`; expect 7 tools. Live, via `npm run inspect`:

- `search_help_center {"query":"trigger conditions","product":"Support"}`
- `get_zendesk_changes {"since":"2026-07-01"}`
- `get_feature_lifecycle {"feature":"offset pagination"}`
- `get_zendesk_status {"subdomain":"yourcompany"}`
