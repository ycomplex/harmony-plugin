---
name: finish-work
description: Use when the user wants to finish, complete, wrap up, land, or merge their current work. Triggers on phrases like "finish", "done", "wrap up", "land this", "merge", "ship it", or "we're done". This is the exit point for ALL development work in this project — it handles the full merge-and-cleanup sequence. In opinionated-mode projects it also drives the releasing + verifying activities; in manual-mode projects it behaves exactly as before.
allowed-tools: mcp__harmony__* Read Grep Glob Bash Bash(gh *)
disallowed-tools: mcp__harmony__record_decision mcp__harmony__supersede_decision mcp__harmony__update_knowledge_entry
---

# Finish Work

Safely land completed work: verify readiness, rebase, squash merge, update main, and clean up the worktree and branch.

## 0. Check project mode

Call `mcp__harmony__get_project`. If `mode !== 'opinionated'`, follow **Manual mode** (the original
merge-and-cleanup flow below — unchanged). If `mode === 'opinionated'`, follow **Opinionated mode**
(it wraps the same merge sequence with the release/verify gates).

---

## Opinionated mode (releasing + verifying)

The ticket should be at **Built** with `awaiting_human_reason = 'release-decision-pending'` (set by
`/harmony-plugin:start-work`). This path drives `releasing` (Built → Released) and `verifying`
(Released → Verified). It does NOT rewrite design knowledge (release role).

### O1. Confirm the release decision (accept clears the gate — it does NOT release yet)

`mcp__harmony__get_task({ task_id })` (read `.harmony-task.json` for the id) and
`mcp__harmony__get_brief({ task_id })`. Show the `release-decision-pending` brief. On the human's
**accept**:

```
mcp__harmony__resolve_brief({ task_id, command: "accept" })   // pending_activity: null → clears the flag, NO state change
```

The release brief carries `pending_activity: null` (state-machine §6.1 — Built→Released is
SYSTEM-on-deploy-success, not human-accept). So accept is only the human's "go"; the ticket stays **Built**
until the deploy actually succeeds (O2). (If the human defers, `resolve_brief({ command: "defer" })` parks
it — do not merge.)

### O2. Run the merge + deploy, THEN advance to Released

Run the **manual-mode merge sequence below** (pre-flight checks → rebase → force-push → wait for CI →
squash merge → cleanup). **Only after the deploy actually succeeds:**

```
mcp__harmony__advance_workflow({ task_id, activity: "releasing" })   // Built -> Released (now reality matches)
```

If CI/deploy goes red, **do not advance** — the ticket stays Built; fix and retry. This is what keeps
`Released` meaning "deployed" (state-machine §6.1), so `verifying` (O3) checks against a real deploy
rather than a state that ran ahead of reality (the B-60 conflation — review F4).

### O3. Verify (Released → Verified)

After deploy, file the verification brief so the human can acknowledge real-world behaviour matches the
design (state-machine §6.1 — verifying is human-ack by default):

```
mcp__harmony__compose_brief({
  task_id, reason: "verification-ack-pending", pending_activity: "verifying",
  doc: { decide: "Does production behaviour match the design?", items: [{ kind: "decision", text: "Acknowledge verified", recommendation: "verify once confirmed" }] }
})
```

On the human's **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept" })` advances
Released→Verified (terminal-positive). Report completion.

> If post-release the human finds a problem, flag a human-authorised backflow:
> `mcp__harmony__advance_workflow({ task_id, activity: "revising-building" })` (Released → Built) and
> hand back to `/harmony-plugin:start-work`.

---

## Manual mode

*(everything below is the original finish-work flow — unchanged)*

## Pre-flight checks

Before doing anything, verify ALL three conditions. If any fail, stop immediately and tell the user what needs to be done — do NOT attempt to fix these yourself.

1. **Working in a worktree?** Check that the current directory is inside `.worktrees/`. If not, error: "You're not in a worktree. Please switch to the worktree for the work you want to finish."

2. **All code committed?** Run `git status` and check for uncommitted changes. If there are any, error: "There are uncommitted changes. Please commit your work before finishing."

3. **PR created?** Check if the current branch has an open PR using `gh pr view`. If not, error: "No PR found for this branch. Please create a PR before finishing."

4. **Acceptance criteria addressed?** (soft check — warning, not a blocker)
   If the task has acceptance criteria, use `list_acceptance_criteria` to check whether all items are marked as done. If not, warn the user:
   "N of M acceptance criteria are not yet checked. Proceed anyway?"
   Similarly check if test cases have been recorded via `list_test_cases`.
   If either is missing, warn but don't block — the user may have valid reasons to skip.

If any of the first three checks fail, stop. Do not proceed. Do not offer to fix it. Just report the issue clearly. For the fourth check, warn but allow the user to override.

## Merge sequence

Once all checks pass:

### 1. Rebase to main

```bash
git fetch origin main
git rebase origin/main
```

If there are conflicts, attempt to resolve them. If anything is ambiguous or unclear, stop and consult the user before continuing.

### 2. Force-push the rebased branch

```bash
git push --force-with-lease
```

### 3. Wait for CI to pass

The force-push triggers a new CI run. Wait for it to complete before merging.

```bash
gh pr checks <PR-number> --watch
```

If CI fails, stop and investigate — do not merge a failing build.

### 4. Squash merge the PR

Use `gh pr merge <PR-number> --squash`. Do NOT pass `--delete-branch` — the branch deletion will fail from inside the worktree and break the flow.

### 5. Switch to parent directory and main branch

```bash
cd <project-root>  # The parent directory outside .worktrees/
git checkout main
git pull origin main
```

The project root is the repository root (parent of `.worktrees/`).

### 6. Kill dev servers running in the worktree

Before removing the worktree, kill any long-lived watchers (dev servers, e2e runners, file watchers) that were started during the work. This prevents orphan processes after the directory is deleted.

```bash
# Kill watchers by name. Adjust the list to match your stack.
pkill -f "vite preview" 2>/dev/null
pkill -f "vite dev" 2>/dev/null
pkill -f playwright 2>/dev/null
```

If no matching processes are running the commands return non-zero silently — this step is best-effort.

**Don't replace these with `lsof +D <worktree> | xargs kill`.** That scans for every process holding a file open under the worktree, which includes the shell running the cleanup and the Claude Code process itself when its CWD is inside the worktree — the agent self-terminates mid-cleanup and the merge tail (worktree removal, branch deletion, Harmony status move) is left half-done. For new watcher types, add another explicit `pkill -f` line above instead.

### 7. Clean up worktree and branches

```bash
git worktree remove .worktrees/<worktree-name>
git branch -d <branch-name>
git push origin --delete <branch-name>
```

### 8. Move Harmony task to Done and annotate

Read `.harmony-task.json` from the worktree root (written by start-work). This contains the task UUID, visual ID, and title. If the file doesn't exist, fall back to inferring the task from the branch name, PR title, or conversation context.

1. Move the task to **Done** using `mcp__harmony__update_task`
2. Add a comment confirming the merge:

```
mcp__harmony__add_comment(task_id, "Merged to main via PR #<number>")
```

The task should be a living record of what happened — see the full task lifecycle reference in the start-work skill.

### 9. Report completion

Confirm that main is updated, the worktree is removed, and branches are pruned.
