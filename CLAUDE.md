# Harmony Plugin for Claude Code

This is the Harmony plugin for Claude Code — an MCP server and workflow skills for Harmony project management.

## MCP Server

- **Language:** Node.js / TypeScript
- **Transport:** stdio
- **Auth:** Requires `HARMONY_API_TOKEN` environment variable
- **Build:** `npm run build` (runs `tsc`)
- **Type-check:** `npx tsc --noEmit`
- **Module resolution:** Node16 — all imports must use `.js` extensions (even for `.ts` source files)
- **Dependencies:** `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`

## Skills

- **start-work** — Find or create a Harmony task, move it to In Progress, create a git worktree, and recommend an execution route (Execute, Plan, or Explore)
- **finish-work** — Verify readiness, rebase, squash merge the PR, clean up the worktree/branches, and move the Harmony task to Done

Both skills depend on the `superpowers` plugin for some functionality (brainstorming, writing-plans, git-worktrees).

## Plugin Structure

```
harmony-plugin/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server config (stdio)
├── hooks/hooks.json             # SessionStart: auto-install + build
├── skills/                      # Workflow skills
├── src/                         # MCP server TypeScript source
├── package.json
└── tsconfig.json
```
