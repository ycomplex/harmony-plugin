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

**B-1007: three branches, and only one of them is hand-written.**

| Branch | What it carries | Who writes it |
|---|---|---|
| `main` | **SOURCE ONLY** — no tracked `dist/` (it is gitignored here), version pinned at the inert `0.0.0-dev` | you, through ordinary PRs |
| `staging` | the same source **plus the two GENERATED artefacts**: a patch-bumped version and a freshly built, committed `dist/` | CI, on every push to `main` — `scripts/generate-staging.sh`, committed as the `harmony-daemon` GitHub App |
| `prod` | what installed plugins actually run | `./promote-prod.sh` in the workspace repo, **fast-forwarding `staging` → `prod`** |

The version in `.claude-plugin/plugin.json` is still **the only signal Claude Code uses to detect
plugin updates** — that goal is untouched. What moved is the *mechanism*: the bump is no longer
something a PR does by hand, it is **generated downstream on `staging`**, one patch bump per push to
`main`. `main`'s `0.0.0-dev` is deliberately inert: it parses as a semver, and `0.0.0` sorts below
every version the marketplace has ever served, so it can never be mistaken for a release.

**The PR gate is INVERTED.** The old rule ("every PR must bump the version") is gone; its
replacement, `scripts/check-generated-artifacts.sh`, enforces the opposite:

> A pull request into `main` must **not** change `.claude-plugin/plugin.json`'s `version`, and must
> **not** touch any path under `dist/**`.

Those two files were the *only* thing two concurrent plugin PRs ever collided on — every PR rebuilt
the same bundle and bumped the same line. Taking both out of the PR removes the collision entirely.
The gate keeps the old one's **fail-closed** property (B-778): an unreadable base or an unparseable
manifest FAILS, it never silently passes. It recognises exactly one exception — the B-1007 cutover
commit itself (base tracks `dist/` at a real version; head tracks none and is inert).

**Drift can't creep in:** `scripts/generate-staging.sh` rebuilds `dist/` from the merged source on
every generation, so what `staging` (and therefore `prod`) carries is always a fresh build of the
source it sits on. That is what `npm run verify:dist` used to check on `main` — which is why B-1007
also dropped it from [`.harmony/project.yml`](.harmony/project.yml)'s `release.before_merge`: with
nothing tracked under `dist/` on `main`, `git diff --exit-code dist` always exits 0, so the step
would have degraded into a silent no-op pass (false confidence, not a check).

**The marketplace pin is UNCHANGED by B-1007.** The `ycomplex/plugins` manifest still pins this
plugin to `source.ref: "prod"`, exactly as before — no file in this repo alters it, and installed
plugins keep updating only when `prod` moves.

**Generation is merge-only, never a reset.** `prod` is *fast-forwarded* from `staging`, so
`origin/prod` must stay an ancestor of `origin/staging`. `scripts/generate-staging.sh` therefore
only ever MERGES `main` into `staging` and pushes without force; a history rewrite there would
permanently break `promote-prod.sh`'s fast-forward preflight. The script is also re-run safe: if the
`main` tip it was handed is already an ancestor of `staging`, it exits having changed nothing (no
double bump, no empty commit).

### Release gate: `main` is dev, `prod` is what ships

The `ycomplex` marketplace pins this plugin to the **`prod`** branch (`source.ref: "prod"`), **not**
`main` and not `staging`. So merging to `main` does *not* reach installed plugins on its own —
Claude Code's auto-update only advances when the `prod` branch moves.

**Why:** the MCP server selects columns/RPCs from the production Supabase DB, which deploys only from harmony-web's `prod` branch and deliberately lags staging during active schema work. If the plugin tracked `main`, a fresh session could auto-update to a version that selects schema prod doesn't have yet, hard-breaking core tools (the `WITHIN GROUP … mode` / `column tasks.workflow_state does not exist` failures — see Harmony **B-383**).

**Invariant:** `prod` must never select DB columns/RPCs that harmony-web *production* lacks.

**Promotion cadence:** when harmony-web is promoted to production, this repo is promoted in the same
step — by the workspace's `./promote-prod.sh`, which pushes web `main → prod`, waits for that deploy
to succeed, and only then fast-forwards this repo's **`staging` → `prod`**. Promotion is no longer
`main → prod`: `main` carries no built `dist/` and no real version, so `staging` is the only
promotable branch.

Plugin-only changes with no new schema dependency (skills, CLI, bug fixes) are safe to promote any time; the gate matters specifically for changes that read newly-added schema. To dogfood `main` ahead of prod, use the **[staging channel](#staging-channel-pre-prod-functional-verify)** below — it wires an ahead-of-prod plugin to the ahead-of-prod staging DB.

### `dist/` is generated on `staging`, gitignored on `main`

Claude Code plugins aren't npm-installed (the marketplace copies files directly into
`~/.claude/plugins/cache/` without running `npm install`), so the compiled `dist/` output **must be
committed on the branch the marketplace serves** — that is how the MCP server runs immediately on a
fresh install. The bundle is produced by `esbuild --bundle`, so all runtime deps are inlined and no
`node_modules/` is needed at runtime.

Since B-1007, the branch that carries it is **`staging` (and, by fast-forward, `prod`) — not
`main`**. `dist/` is gitignored on `main` and CI generates it on `staging`:
`scripts/generate-staging.sh` merges `main` into `staging`, patch-bumps the version, runs
`npm ci && npm run build`, and commits both with `git add -f dist .claude-plugin/plugin.json` (the
`-f` is required because `.gitignore` is shared across branches).

**Locally**, `npm run build` still works exactly as before and still writes `dist/` — it is simply
untracked here. That build is the one declared step in
[`.harmony/project.yml`](.harmony/project.yml)'s `release.before_merge` (`npm run verify:dist` was
dropped — see Versioning above for why it degrades to a no-op on a source-only `main`).

**B-991: the authoritative declaration of the release-prep steps lives in this repo's own
[`.harmony/project.yml`](.harmony/project.yml)** (`release.before_merge`), not here — this section is
a pointer, kept only as a human-readable summary. Run them via `harmony gates run
release.before_merge` (src/cli/commands/gates.ts), which reads the manifest, runs those steps
as subprocesses, and lands a `finish-work` evidence entry (typed `integration`) when it runs steps for real; `skills/finish-work/SKILL.md`'s
release-prep step calls this automatically when `.harmony/project.yml` is present, falling back to
this section's steps verbatim when it is absent (see `src/config/project-manifest.ts`'s header for
why an absent/empty manifest must behave identically to today).

**What CI runs on a PR** is no longer `npm run verify:dist` but
`scripts/check-generated-artifacts.sh` — the inverted gate described above. The staging generation
job (push to `main`) is the thing that builds and commits the bundle.

**B-992:** any adopter of `.harmony/project.yml` (B-991) that also wants the PreToolUse gate's enforcement (`hooks/pretooluse-gate.sh` — denies a positively-identified daemon worker from opening/merging a PR or accepting a verify brief until the declared gate point has run) must also gitignore `.harmony/.gate-evidence/` — the local, best-effort evidence markers `harmony gates run <extension-point>` writes there are never meant to be committed. This repo's own `.gitignore` is the reference example.

## Staging channel (pre-prod functional verify)

The sanctioned way to functionally verify plugin changes — **skills AND MCP code** — before promoting to prod: run the `main` (or branch) checkout against the **staging** Supabase project, so ahead-of-prod code talks to an ahead-of-prod DB.

**It stays on `main`, deliberately** — do not repoint it at the `staging` *branch*. The channel
exists to verify merged-but-unpromoted **source**; pinning it to the generated branch would hide the
very source-only `main` it is there to exercise. (The branch and the channel share a name and
nothing else: the channel's "staging" is the staging *Supabase project*.)

**Engage it via the setup script, into a DEDICATED out-of-repo dogfood directory** — never inside this repo, harmony-web, or the workspace root (`promote-prod.sh` aborts on untracked files, and dogfood residue like `.claude/` would trip it):

```bash
./scripts/setup-staging-channel.sh ~/harmony-dogfood <staging-api-token> [staging-anon-key]
cd ~/harmony-dogfood && claude --plugin-dir /path/to/main/checkout/of/harmony-plugin
```

**There is no committed `dist/` on `main` any more, so first launch builds.** The plugin's
SessionStart hook (`hooks/hooks.json`) runs `npm install --silent && npm run build` whenever
`${CLAUDE_PLUGIN_ROOT}/dist/index.js` is absent — about **8 seconds** on this bundle, once per fresh
checkout, and then never again. This was proven live at B-1007 design time against a dist-less
checkout: the hook-built bundle was byte-identical to the committed one. Nothing about the channel's
setup changes; just expect that one first-launch pause.

The script writes the dogfood dir's `.claude/settings.local.json` (staging `HARMONY_SUPABASE_URL` / `HARMONY_SUPABASE_ANON_KEY` / `HARMONY_API_TOKEN`), disables the marketplace-installed `harmony-plugin@ycomplex` in that dir's `.claude/settings.json` so the local checkout is the only Harmony plugin loaded, and ensures `.claude/` is excluded in this checkout's git exclude file. It is idempotent and merge-safe.

**Confirm the pairing before trusting any verify result:** call `get_project` and check its `environment` block — `target` must be `staging` and `plugin_version` must be the version you built. On a `main` checkout that version now reads `0.0.0-dev` (the inert source-only marker), which is itself the confirmation that you are running local source rather than the installed prod plugin.

**Fallback on identity collision:** if `--plugin-dir` collides with the marketplace install (same plugin name resolving to the cached copy), use the cache-overwrite generalization — rsync (copy-paste) `dist/`, `skills/`, and `.claude-plugin/` over `~/.claude/plugins/cache/ycomplex/harmony-plugin/<installed-version>/`. Run `npm run build` first: on `main` the `dist/` you are copying is a local build artefact, not a committed one. It is reversible by reinstalling the plugin from the marketplace. This supersedes the old skills-only cache hack (overwriting just `skills/` in the cache) — the generalized form covers MCP code too.

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
