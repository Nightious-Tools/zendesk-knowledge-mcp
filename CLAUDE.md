# zendesk-knowledge-mcp

Read-only MCP stdio server over support.zendesk.com, developer.zendesk.com, and status.zendesk.com.
`src/server.ts` registers tools; `src/util/http.ts` is the domain allow-list (the security boundary:
keep it strict). README "How answers stay grounded" explains the design.

## dist/ is what runs

`dist/index.mjs` is an esbuild bundle of `src/`, committed, and every install channel executes it
directly; nothing builds on the user's machine and no `npm install` runs. Runtime deps are therefore
devDependencies. After any `src/` edit, run `npm run build` and commit `dist/` in the same commit; CI
fails on a stale bundle. The `createRequire` banner in the build script is required (cheerio pulls CJS
deps that call `require`).

## One repo, two plugin hosts

| File | Read by |
|---|---|
| `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json` | Claude Code |
| `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `.mcp.json` | Codex |
| `skills/zendesk-knowledge/SKILL.md` | both |

Codex does not expand `${CLAUDE_PLUGIN_ROOT}`, so `.mcp.json` uses a relative path plus `"cwd": "."`.
Claude Code also loads `.mcp.json`; the inline server in `.claude-plugin/plugin.json` has the **same
name** (`zendesk-knowledge`) so it overrides that entry. Keep the names identical.

## Lockstep

| When you change | Also update |
|---|---|
| version | `package.json`, `src/server.ts` (`SERVER_VERSION`), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`. CI fails if they disagree. Then rebuild and tag a release. |
| a tool or param | `src/server.ts`, `README.md`, `skills/zendesk-knowledge/SKILL.md` |
| plugin/server name | all five manifest files above plus `.mcp.json` and README install commands |

## Releasing

```
npm run typecheck && npm test && npm run build
git push
gh release create v<X.Y.Z> --title "v<X.Y.Z>" --notes "..."
```

Publish as GitHub user `nightious` (`gh auth switch -u nightious`); this repo's git `user.name` matches.

## Verification

`npm test` is offline (fetch stub). For the bundle, copy `dist/index.mjs` alone into an empty directory
and pipe `initialize` + `tools/list` JSON-RPC into `node index.mjs`: it must list 7 tools. For live
behaviour use `npm run inspect` with the queries in the README.
