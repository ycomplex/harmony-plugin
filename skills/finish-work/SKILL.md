---
name: finish-work
description: Use when the user wants to finish, complete, wrap up, land, or merge their current work. Triggers on phrases like "finish", "done", "wrap up", "land this", "merge", "ship it", or "we're done". This is the exit point for ALL development work in this project — it handles the full merge-and-cleanup sequence.
---

# Finish Work

Safely land completed work: verify readiness, rebase, squash merge, update main, and clean up the worktree and branch.

## Pre-flight checks

Before doing anything, verify ALL three conditions. If any fail, stop immediately and tell the user what needs to be done — do NOT attempt to fix these yourself.

1. **Working in a worktree?** Check that the current directory is inside `.worktrees/`. If not, error: "You're not in a worktree. Please switch to the worktree for the work you want to finish."

2. **All code committed?** Run `git status` and check for uncommitted changes. If there are any, error: "There are uncommitted changes. Please commit your work before finishing."

3. **PR created?** Check if the current branch has an open PR using `gh pr view`. If not, error: "No PR found for this branch. Please create a PR before finishing."

If any check fails, stop. Do not proceed. Do not offer to fix it. Just report the issue clearly.

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

Before removing the worktree, find and kill any processes (dev servers, watchers, etc.) whose working directory is inside the worktree. This prevents orphan processes after the directory is deleted.

```bash
# Find node/vite processes running inside the worktree
lsof +D .worktrees/<worktree-name> 2>/dev/null | awk 'NR>1 {print $2}' | sort -u | xargs kill 2>/dev/null
```

If no processes are found, continue silently — this step is best-effort.

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
