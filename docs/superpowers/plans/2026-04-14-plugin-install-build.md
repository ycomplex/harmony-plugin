# Fix Plugin Install Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make harmony-plugin work end-to-end on a fresh marketplace install, without relying on a SessionStart hook to race the MCP server's startup.

**Architecture:** Hybrid — ship the prebuilt `dist/` in the repo so the MCP server has an artifact to run the moment the plugin is cached, and keep a simplified `SessionStart` hook as a safety net for developer installs (`--plugin-dir` from an uncompiled checkout). Add a `prepack`/release guard so `dist/` cannot drift from `src/` at version-bump time.

**Tech Stack:** Node.js 20+, TypeScript 5.8, `tsc` build, `vitest` for tests. No runtime changes — the fix is entirely build/packaging.

**Context for the engineer:**
- Plugins distributed via Claude Code marketplaces are **not** npm-installed. Claude Code copies the plugin into `~/.claude/plugins/cache/<owner>/<plugin>/<version>/`. It does not run `npm install`, and `package.json` `postinstall` scripts are never invoked.
- Claude Code plugins expose runtime hook events only (`SessionStart`, `PreToolUse`, etc.). There is no `PluginInstall` / `PostInstall` lifecycle event.
- `.mcp.json` in this plugin points at `${CLAUDE_PLUGIN_ROOT}/dist/index.js`. If that file is missing when the session starts, the MCP server fails. The SessionStart hook can build it, but MCP startup can race the hook.
- The cleanest fix is to commit `dist/` so the artifact is always present after `git clone` / marketplace cache.

---

### Task 1: Commit prebuilt `dist/` to the repo

**Files:**
- Modify: `.gitignore`
- Add: `dist/` (entire compiled output)

- [ ] **Step 1: Build a clean `dist/`**

```bash
cd /Users/akshay/Development/harmony/plugin/.worktrees/fix-plugin-install
rm -rf dist
npm run build
```

Expected: `dist/index.js`, `dist/bin/harmony.js`, and `.d.ts` / `.js.map` siblings exist. No errors.

- [ ] **Step 2: Remove `dist/` from `.gitignore`**

Edit `.gitignore`. Delete the `dist/` line so compiled output is tracked. Keep `node_modules/`, `.DS_Store`, `.worktrees/`, `coverage/`, `.harmony-task.json`.

Current:
```
node_modules/
dist/
.DS_Store
.worktrees/
coverage/
.harmony-task.json
```

After:
```
node_modules/
.DS_Store
.worktrees/
coverage/
.harmony-task.json
```

- [ ] **Step 3: Sanity-check the diff**

```bash
git status
git diff .gitignore
```

Expected: `.gitignore` diff shows only the `dist/` line removed. `git status` shows `dist/` as untracked (ready to add).

- [ ] **Step 4: Stage and commit**

```bash
git add .gitignore dist
git commit -m "Ship prebuilt dist/ so fresh installs work without build step"
```

Expected: commit succeeds. `git log --stat -1` shows all `dist/**` files plus the `.gitignore` change.

---

### Task 2: Simplify the SessionStart hook

**Rationale:** With `dist/` committed, the hook no longer carries the load of fresh installs. Keep it narrow — only rebuild when running from a dev checkout that has no `dist/` yet (e.g., `claude --plugin-dir ./plugin` immediately after a fresh clone before `npm install`). Drop the `&& echo '{}'` JSON contract complexity and the `>&2` redirect, since this is just a safety net now.

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Rewrite `hooks/hooks.json`**

Current:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"${CLAUDE_PLUGIN_ROOT}\" && ([ -f dist/index.js ] || (npm install && npx tsc) >&2) && echo '{}'",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

Replace with:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "if [ ! -f \"${CLAUDE_PLUGIN_ROOT}/dist/index.js\" ]; then cd \"${CLAUDE_PLUGIN_ROOT}\" && npm install --silent && npx tsc >&2; fi; echo '{}'",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

Changes:
- Early-return fast path when `dist/` already exists (the common case).
- `npm install --silent` reduces noise.
- `echo '{}'` is always emitted so the hook contract is satisfied even when no build runs.
- Timeout bumped 120→180s to cover slow first-build networks in dev.

- [ ] **Step 2: Verify the hook is valid JSON**

```bash
cd /Users/akshay/Development/harmony/plugin/.worktrees/fix-plugin-install
node -e "console.log(JSON.parse(require('fs').readFileSync('hooks/hooks.json', 'utf8')))"
```

Expected: prints the parsed object, no SyntaxError.

- [ ] **Step 3: Smoke-test the fast-path command manually**

```bash
CLAUDE_PLUGIN_ROOT="$(pwd)" bash -c 'if [ ! -f "${CLAUDE_PLUGIN_ROOT}/dist/index.js" ]; then cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent && npx tsc >&2; fi; echo "{}"'
```

Expected: single `{}` on stdout, nothing else. (dist/ already exists so the build branch is skipped.)

- [ ] **Step 4: Smoke-test the slow-path command**

```bash
CLAUDE_PLUGIN_ROOT="$(pwd)" bash -c 'mv dist dist.bak; if [ ! -f "${CLAUDE_PLUGIN_ROOT}/dist/index.js" ]; then cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent && npx tsc >&2; fi; echo "{}"; rm -rf dist; mv dist.bak dist'
```

Expected: rebuilds, emits `{}` on stdout, tsc output goes to stderr. `dist/` restored at the end.

- [ ] **Step 5: Commit**

```bash
git add hooks/hooks.json
git commit -m "Simplify SessionStart build hook — dev safety net only"
```

---

### Task 3: Add a release guard so `dist/` can't drift

**Rationale:** Committing `dist/` introduces a failure mode: someone changes `src/` and bumps `plugin.json` version without rebuilding. Users then install a new plugin version with stale compiled code. Add a `prepack`/verification script plus a CLAUDE.md note so this is caught.

**Files:**
- Modify: `package.json` (add `prepack` script)
- Modify: `CLAUDE.md` (add release checklist note)

- [ ] **Step 1: Add a `verify:dist` script to `package.json`**

In the `scripts` block of `package.json`, after the existing `build` line, add:

```json
    "verify:dist": "rm -rf dist && tsc && git diff --exit-code dist",
```

Final `scripts` block:
```json
  "scripts": {
    "build": "tsc",
    "verify:dist": "rm -rf dist && tsc && git diff --exit-code dist",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

The `git diff --exit-code dist` exits non-zero if the fresh build differs from the committed `dist/`, catching drift in CI or locally.

- [ ] **Step 2: Smoke-test `verify:dist`**

```bash
cd /Users/akshay/Development/harmony/plugin/.worktrees/fix-plugin-install
npm run verify:dist
```

Expected: exits 0 — fresh build matches committed `dist/`.

- [ ] **Step 3: Confirm it catches drift**

```bash
echo "// drift test" >> src/index.ts
npm run verify:dist || echo "VERIFY FAILED AS EXPECTED"
git checkout -- src/index.ts dist
```

Expected: the middle line prints `VERIFY FAILED AS EXPECTED`; last line reverts the changes.

- [ ] **Step 4: Update CLAUDE.md with a release note**

In `CLAUDE.md`, under `## Versioning`, append this paragraph:

```markdown
### `dist/` is tracked in git

Because Claude Code plugins aren't npm-installed (the marketplace copies files directly into `~/.claude/plugins/cache/`), the compiled `dist/` output is committed to the repo so the MCP server runs immediately on fresh install.

**Before bumping the version in `.claude-plugin/plugin.json`:**
1. Run `npm run build`
2. Verify with `npm run verify:dist` — this rebuilds and fails if committed `dist/` differs from a fresh build
3. Commit any `dist/` changes alongside the version bump

CI should run `npm run verify:dist` on every PR.
```

- [ ] **Step 5: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "Add verify:dist release guard and document dist/ tracking"
```

---

### Task 4: Bump plugin version

**Rationale:** Per project rules in `plugin/CLAUDE.md`: "Every PR must bump the version in `.claude-plugin/plugin.json`. This is how Claude Code detects plugin updates — without a version bump, users won't pick up the changes."

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Bump patch version**

Current `.claude-plugin/plugin.json` version is `0.4.0`. Change to `0.4.1`.

- [ ] **Step 2: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "Bump plugin version to 0.4.1"
```

---

### Task 5: Full verification pass

- [ ] **Step 1: Run the test suite**

```bash
cd /Users/akshay/Development/harmony/plugin/.worktrees/fix-plugin-install
npm test
```

Expected: 93 tests pass, 0 fail.

- [ ] **Step 2: Run `verify:dist` one more time**

```bash
npm run verify:dist
```

Expected: exits 0.

- [ ] **Step 3: Confirm clean git state**

```bash
git status
```

Expected: `working tree clean` (with possible untracked `.harmony-task.json`, which is fine — it's gitignored).

- [ ] **Step 4: Simulate a fresh-install scenario**

Create a temp copy of the plugin, delete `node_modules/`, and verify `dist/index.js` is runnable:

```bash
TMPDIR_TEST=$(mktemp -d)
rsync -a --exclude node_modules --exclude .git ./ "$TMPDIR_TEST/"
cd "$TMPDIR_TEST"
node -e "import('./dist/index.js').then(() => console.log('MCP entrypoint loads'))" 2>&1 | head
cd -
rm -rf "$TMPDIR_TEST"
```

Expected: either `MCP entrypoint loads` prints, or the script exits without a module-resolution error (the MCP stdio server may hang waiting for input, which is fine — kill with Ctrl-C). The key is no `ERR_MODULE_NOT_FOUND` or missing-file errors.

- [ ] **Step 5: Push and create PR**

```bash
git push -u origin fix/plugin-install-build
gh pr create --title "Ship prebuilt dist/ so fresh plugin installs work" --body "$(cat <<'EOF'
## Summary
- Commit prebuilt `dist/` so the MCP server has its entrypoint the moment Claude Code caches the plugin (fixes fresh-install failures where SessionStart raced MCP startup).
- Simplify `SessionStart` hook to a dev-only safety net (rebuilds only when `dist/` is missing).
- Add `npm run verify:dist` release guard to prevent compiled output from drifting from source.
- Document the tracked-`dist/` convention in `CLAUDE.md`.

## Why
Validated against Anthropic's plugin docs: there's no `PluginInstall`/`PostInstall` lifecycle hook, and Claude Code doesn't run `npm install` on marketplace installs. So `package.json` `postinstall` won't fire. Shipping compiled output is the officially-compatible pattern for plugins that need a runtime artifact.

Closes B-244.

## Test plan
- [x] `npm test` — 93 passing
- [x] `npm run verify:dist` — clean
- [x] Manual: SessionStart hook fast-path and slow-path smoke tests
- [ ] Install the new plugin version into a fresh Claude Code session and confirm MCP tools load without running a build
EOF
)"
```

- [ ] **Step 6: Move B-244 to In Review + add PR URL**

```
mcp__harmony__update_task(task_id: "ff81e0b4-f4c2-41eb-a06b-8c4e19104f40", status: "In Review")
mcp__harmony__add_comment(task_id: "ff81e0b4-f4c2-41eb-a06b-8c4e19104f40", content: "PR created: <url>")
```

- [ ] **Step 7: STOP**

Per project rule: do not auto-finish. Wait for the user to validate and say "finish work".

---

## Self-review

**Spec coverage:**
- ✅ Fresh plugin install works without manual build → Task 1 (commit dist/)
- ✅ MCP server starts successfully on first session → Task 1 removes the startup race
- ✅ Plugin version bump still works across updates → Task 4
- ✅ Developer workflow (`npm run build`) intact → Task 2 keeps SessionStart as safety net; `build` script unchanged

**Placeholder scan:** All steps have exact paths, exact code, exact commands. No "TBD" or "implement later."

**Consistency:** `verify:dist` name used consistently. `CLAUDE_PLUGIN_ROOT` quoted in all hook commands. Version `0.4.0 → 0.4.1` explicit.

**One caveat worth flagging at execution time:** the final PR-merge validation (plugin actually installs cleanly via the marketplace in a fresh Claude Code session) can only be done by the user after the PR is merged and the marketplace picks up the new version. The plan verifies as much as is verifiable pre-merge.
