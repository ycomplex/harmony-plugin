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
- **Lint:** `npm run lint` (runs `eslint . --max-warnings=0` — enforced 0 warnings; fix or suppress inline with a reason)
- **Module resolution:** Node16 — source imports must use `.js` extensions (even for `.ts` source files). esbuild resolves them at bundle time.
- **Dependencies:** `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`

## Skills

- **harmony-conduct** — The opinionated-mode entry point: drive one ticket through the whole gate sequence (clarify → decompose → design → plan → build → release → verify), pausing at each gate for the human's decision
- **start-work** — Manual mode: find or create a Harmony task, move it to In Progress, create a git worktree, and recommend an execution route (Execute, Plan, or Explore). Opinionated mode: implements the planning + building gates the conductor delegates to (directly invokable to run just those gates)
- **finish-work** — Manual mode: verify readiness, rebase, squash merge the PR, clean up the worktree/branches, and move the Harmony task to Done. Opinionated mode: implements the release (merge + deploy) + verify gates the conductor delegates to; crossed only on your explicit "finish work" / "land it" / "merge it"

Both skills depend on the `superpowers` plugin for some functionality (brainstorming, writing-plans, git-worktrees).

## Ticket disposition

When you retire a Harmony ticket — including the general conversational "let's drop this" — follow the one convention in `skills/harmony-shared/ticket-disposition.md`, keyed on **does the work continue?**: fold/dedup → **subsume** (keep its `workflow_state`, never additionally Cancel); won't-be-done → **cancel+archive** (`advance_workflow` `cancelling` → `add_comment` with the reason → `update_task archived:true`, in that order — never archive-only, never cancel-only); re-homed → **reparent**; deferred → **park** (Parked). The disposal-surface skills (harmony-conduct, harmony-revise-scope) already wire this in; this is the last-resort pointer for ad-hoc "drop this" actions. Its adjacent axis — what a *surfaced item* becomes — is `skills/harmony-shared/disposition-discipline.md`.

## Versioning

Every PR must bump the version in `.claude-plugin/plugin.json`. This is how Claude Code detects plugin updates — without a version bump, users won't pick up the changes.

### Release gate: `main` is dev, `prod` is what ships

The `ycomplex` marketplace pins this plugin to the **`prod`** branch (`source.ref: "prod"`), **not** `main`. So merging to `main` does *not* reach installed plugins on its own — Claude Code's auto-update only advances when the `prod` branch moves.

**Why:** the MCP server selects columns/RPCs from the production Supabase DB, which deploys only from harmony-web's `prod` branch and deliberately lags staging during active schema work. If the plugin tracked `main`, a fresh session could auto-update to a version that selects schema prod doesn't have yet, hard-breaking core tools (the `WITHIN GROUP … mode` / `column tasks.workflow_state does not exist` failures — see Harmony **B-383**).

**Invariant:** `prod` must never select DB columns/RPCs that harmony-web *production* lacks.

**Promotion cadence:** when harmony-web is promoted to production (`git push origin main:prod` in harmony-web), fast-forward this repo the same way, in the same step:

```bash
git push origin main:prod   # in harmony-plugin
```

Plugin-only changes with no new schema dependency (skills, CLI, bug fixes) are safe to promote any time; the gate matters specifically for changes that read newly-added schema. To dogfood `main` ahead of prod, use the **[staging channel](#staging-channel-pre-prod-functional-verify)** below — it wires an ahead-of-prod plugin to the ahead-of-prod staging DB.

### `dist/` is tracked in git

Because Claude Code plugins aren't npm-installed (the marketplace copies files directly into `~/.claude/plugins/cache/` without running `npm install`), the compiled `dist/` output is committed so the MCP server runs immediately on fresh install. The bundle is produced by `esbuild --bundle`, so all runtime deps are inlined — no `node_modules/` is needed at runtime.

**Before bumping the version in `.claude-plugin/plugin.json`:**
1. Run `npm run build`
2. Verify with `npm run verify:dist` — this rebuilds and fails if committed `dist/` differs from a fresh build
3. Commit any `dist/` changes alongside the version bump

CI should run `npm run verify:dist` on every PR.

## Staging channel (pre-prod functional verify)

The sanctioned way to functionally verify plugin changes — **skills AND MCP code** — before promoting to prod: run the `main` (or branch) checkout against the **staging** Supabase project, so ahead-of-prod code talks to an ahead-of-prod DB.

**Engage it via the setup script, into a DEDICATED out-of-repo dogfood directory** — never inside this repo, harmony-web, or the workspace root (`promote-prod.sh` aborts on untracked files, and dogfood residue like `.claude/` would trip it):

```bash
./scripts/setup-staging-channel.sh ~/harmony-dogfood <staging-api-token> [staging-anon-key]
cd ~/harmony-dogfood && claude --plugin-dir /path/to/main/checkout/of/harmony-plugin
```

The script writes the dogfood dir's `.claude/settings.local.json` (staging `HARMONY_SUPABASE_URL` / `HARMONY_SUPABASE_ANON_KEY` / `HARMONY_API_TOKEN`), disables the marketplace-installed `harmony-plugin@ycomplex` in that dir's `.claude/settings.json` so the local checkout is the only Harmony plugin loaded, and ensures `.claude/` is excluded in this checkout's git exclude file. It is idempotent and merge-safe.

**Confirm the pairing before trusting any verify result:** call `get_project` and check its `environment` block — `target` must be `staging` and `plugin_version` must be the version you built. That is the code/DB confirmation; without it you may be verifying the installed prod plugin against prod.

**Fallback on identity collision:** if `--plugin-dir` collides with the marketplace install (same plugin name resolving to the cached copy), use the cache-overwrite generalization — rsync (copy-paste) `dist/`, `skills/`, and `.claude-plugin/` over `~/.claude/plugins/cache/ycomplex/harmony-plugin/<installed-version>/`. It is reversible by reinstalling the plugin from the marketplace. This supersedes the old skills-only cache hack (overwriting just `skills/` in the cache) — the generalized form covers MCP code too.

**Successor:** this channel becomes a proper two-marketplace setup (a staging marketplace entry alongside prod) once the upstream Claude Code same-name plugin collision bug is fixed; until then `--plugin-dir` + the cache-overwrite fallback is the supported path.

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
