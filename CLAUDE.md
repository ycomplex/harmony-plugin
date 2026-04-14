# Harmony Plugin for Claude Code

This is the Harmony plugin for Claude Code — an MCP server, CLI, and workflow skills for Harmony project management.

## CLI

The `harmony` CLI provides the same functionality as the MCP server for direct terminal use.

- **Binary:** `harmony` (via `npx @harmony-ad/harmony` or local `node dist/bin/harmony.js`)
- **Config:** `~/.harmony/config.json` (multi-project auth tokens)
- **Output modes:** Human-readable tables (default) or `--json` for scripting
- **Help:** `harmony --help`, `harmony <command> --help`

### Quick start

```bash
harmony login --token <your-api-token>
harmony tasks list
harmony tasks get B-42
harmony tasks create --title "New task" --priority high
```

## MCP Server

- **Language:** Node.js / TypeScript
- **Transport:** stdio
- **Auth:** Requires `HARMONY_API_TOKEN` environment variable
- **Build:** `npm run build` (runs `esbuild` — bundles all runtime deps into `dist/` as ESM). The bundled output is self-contained: `node dist/index.js` works with no `node_modules/` present.
- **Type-check:** `npm run typecheck` (runs `tsc --noEmit`)
- **Module resolution:** Node16 — source imports must use `.js` extensions (even for `.ts` source files). esbuild resolves them at bundle time.
- **Dependencies:** `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`

## Skills

- **start-work** — Find or create a Harmony task, move it to In Progress, create a git worktree, and recommend an execution route (Execute, Plan, or Explore)
- **finish-work** — Verify readiness, rebase, squash merge the PR, clean up the worktree/branches, and move the Harmony task to Done

Both skills depend on the `superpowers` plugin for some functionality (brainstorming, writing-plans, git-worktrees).

## Versioning

Every PR must bump the version in `.claude-plugin/plugin.json`. This is how Claude Code detects plugin updates — without a version bump, users won't pick up the changes.

### `dist/` is tracked in git

Because Claude Code plugins aren't npm-installed (the marketplace copies files directly into `~/.claude/plugins/cache/` without running `npm install`), the compiled `dist/` output is committed so the MCP server runs immediately on fresh install. The bundle is produced by `esbuild --bundle`, so all runtime deps are inlined — no `node_modules/` is needed at runtime.

**Before bumping the version in `.claude-plugin/plugin.json`:**
1. Run `npm run build`
2. Verify with `npm run verify:dist` — this rebuilds and fails if committed `dist/` differs from a fresh build
3. Commit any `dist/` changes alongside the version bump

CI should run `npm run verify:dist` on every PR.

## Plugin Structure

```
harmony-plugin/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server config (stdio)
├── hooks/hooks.json             # SessionStart: auto-install + build
├── skills/                      # Workflow skills
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── auth.ts                  # Token exchange (shared)
│   ├── supabase.ts              # Supabase client (shared)
│   ├── tools/                   # Handlers — shared core for MCP + CLI
│   ├── bin/harmony.ts           # CLI binary entry point
│   └── cli/                     # CLI commands and formatting
├── package.json
└── tsconfig.json
```
