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

### O0. PR-less umbrella? (a decomposed parent whose work shipped in its children — B-471)

**Check this BEFORE the release pre-flight.** A decomposed parent (an "umbrella") has NO branch/PR of its
own — its real work shipped in its children's PRs. The DB trigger auto-advances such a parent
**Decomposed → Released** once all active children reach **Verified**, and surfaces verify by setting on
the parent row `awaiting_human_input = true`, `awaiting_human_reason = 'verification-ack-pending'`,
`awaiting_human_ref = {"kind":"umbrella-auto-verify"}` — **but it does NOT compose a brief** (so
`get_brief` returns null for the umbrella until this skill composes one).

**The umbrella's `task_id` is the ticket id passed to this skill** — an umbrella has no worktree of its
own and therefore no `.harmony-task.json`; the cwd may even hold a *different* ticket's `.harmony-task.json`,
so do **NOT** read `task_id` from that file for an umbrella. Use the ticket id you were invoked with.

**Detect an umbrella (the authoritative marker is the primary key):**

1. **Primary — the purpose-built marker.** `mcp__harmony__get_task({ task_id })` and check
   `awaiting_human_ref.kind === 'umbrella-auto-verify'`. The harmony-web Phase-1 trigger sets this on an
   auto-advanced umbrella parent, alongside `workflow_state = 'Released'`,
   `awaiting_human_input = true`, and `awaiting_human_reason = 'verification-ack-pending'`. Equivalently:
   `workflow_state = 'Released'` + `awaiting_human_reason = 'verification-ack-pending'` + it has children.
   This `awaiting_human_ref.kind` marker is the authoritative, purpose-built signal — prefer it over any
   proxy.
2. **Corroboration only — has children, no open PR.** `mcp__harmony__list_subtasks({ task_id })` shows it
   **has children**, and there is **no open PR for its branch** (`.harmony-task.json` has no `branch`, or
   `gh pr view` fails). Treat these as confirmation, **not** as the primary signal: an umbrella has no
   worktree of its own, so `gh pr view` runs against whatever arbitrary branch the cwd happens to be on and
   is unreliable on its own.

Such an umbrella is already at `workflow_state` **Released** (auto-advanced) with
`awaiting_human_reason = 'verification-ack-pending'` and `awaiting_human_ref.kind = 'umbrella-auto-verify'`.

**If it is an umbrella → take the umbrella verify path and SKIP O1/O2 entirely** (there is no code to
merge — the children each shipped their own PR; do NOT run the release-decision gate or the merge/deploy
sequence, and do NOT touch git):

- **Edge — still Decomposed (not all children Verified):** if `mcp__harmony__get_task` shows the umbrella
  is still at `Decomposed` (the trigger hasn't fired — and `awaiting_human_ref.kind` is therefore NOT
  `'umbrella-auto-verify'`), it simply isn't ready: not all active children have reached `Verified`. Do
  **NOT** verify. Tell the human it is not ready — its children are still in flight — and stop. Note that
  `list_subtasks` selects each child's kanban `status`, **not** its `workflow_state` (where `Verified`
  lives), so it cannot tell you which children are un-Verified. If you want to enumerate the un-Verified
  children, `mcp__harmony__get_task` each child and read its `workflow_state`.
- **Compose the verify brief if missing:** `mcp__harmony__get_brief({ task_id })`. If it is **null** (the
  trigger set the flag but composed no brief), compose it. **Also render the B-560 evidence-status line**
  (call `mcp__harmony__get_build_evidence_status({ task_id })` first, prepend it to the brief — for an
  umbrella it renders `Evidence: N/A (umbrella — carried by children)`, the explicit AC4 exemption):

  ```
  mcp__harmony__compose_brief({
    task_id, reason: "verification-ack-pending", pending_activity: "verifying",
    doc: { decide: "Does the umbrella work end-to-end across its children?", items: [
      { kind: "decision", text: "Acknowledge the umbrella works end-to-end across its children", recommendation: "verify once confirmed" }
    ] }
  })
  ```

- **Resolve on human ack:** show the brief; on the human's **accept** →
  `mcp__harmony__resolve_brief({ task_id, command: "accept" })` advances **Released → Verified**
  (terminal-positive). **No git.** Report completion and stop — do not fall through to O1/O2/O3.

(If `awaiting_human_ref.kind` is not `'umbrella-auto-verify'` — e.g. the ticket has NO children, or it has
its own open PR/branch — it is a normal ticket: skip this section and continue to O1.)

### O1. Confirm the release decision (accept clears the gate — it does NOT release yet)

`mcp__harmony__get_task({ task_id })` (read `.harmony-task.json` for the id) and
`mcp__harmony__get_brief({ task_id })`. Show the `release-decision-pending` brief.

**Risk-class signal on the release brief (B-516).** Before surfacing the brief, compute a **path-based**
risk signal from the build's changed paths and show it as an **attention line** above the decision, so the
human reviews any high-consequence class at the release gate (the hard floor). This is where the conductor's
risk-class floor lands for `--unattended`/`--pause-at` runs: those runs do NOT pause mid-flight on a risk
class — the signal surfaces *here* instead (see harmony-conduct §3a / §4 "release-brief risk signal").

1. Get the build's changed paths (high-precision — path-based, not prose): from the worktree,
   `git diff --name-only origin/main...HEAD` (the PR diff). For an umbrella with no diff of its own, skip
   this signal (its children carried the risk at their own release gates).
2. Pass those paths into `get_task` so `risk_classes` reflects the diff:
   `mcp__harmony__get_task({ task_id, changed_paths: [<the diff paths>] })`.
3. If `risk_classes` is **non-empty**, prepend an attention line to what you show the human, e.g.:
   *"⚠ Risk floor: this change touches **auth + data-migration** — review accordingly before releasing."*
   (List the classes from `risk_classes`, comma-joined.) If it is empty, show nothing extra.

Prefer this path-derived signal over any prose-derived set — the path signal is high-precision and avoids the
prose false-positives B-516 fixed. On the human's **accept**:

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

**Land the release trail on the ticket (B-560) — NON-OPTIONAL.** Immediately after the deploy
succeeds and the state advances, comment the build→release→deploy trail so the ticket carries it as
durable evidence (gates only advance `workflow_state`; a delegated/worktree build never touches the
ticket, so without this the trail is lost — B-551 hit Verified with zero build trail):

```
mcp__harmony__add_comment({ task_id, content: "Released via PR #<number> — squash-merged to main; deploy succeeded (<run-id/url>)." })
```

**DRAIN the "Follow-ups rollup" buffer at the release gate + surface the audit (B-585, B-641).** If
out-of-scope items surfaced during this run (adjacent bugs, refactors, review nits) that weren't fix-first'd
into the PR, the rollup is a **within-run buffer** that must now be **DRAINED** — every item resolves to
exactly one of four terminal outcomes (**fix-inline / fold-into-existing / drop-with-reason / file-a-ticket**);
**nothing persists as a note**. A fold must gate the host's completion (an **AC / scope item** or
`subsume_task`) — a **bare comment is not a fold**. Post — alongside the release trail above — ONE
consolidated **"Follow-ups rollup"** comment (accumulated in-session) recording each item's terminal
resolution, running **triage-and-consolidate** for fold-vs-file: `find_related_tickets` → prefer **fold**
(`subsume_task`) or **dedupe** over minting; mint a new ticket only when genuinely novel; a
`defer-with-trigger` becomes a fold or a **low-priority backlog ticket with the trigger in its body**. Then
**surface the drained buffer on the release brief** — each item as filed (with IDs) / folded (into which
tickets) / dropped (with reasons) — so the human can **veto a drop or upgrade a fold to a file before
verify** (drain → surface → verify). See `skills/harmony-shared/disposition-discipline.md`. (Skip if nothing
surfaced.)

If CI/deploy goes red, **do not advance** — the ticket stays Built; fix and retry. This is what keeps
`Released` meaning "deployed" (state-machine §6.1), so `verifying` (O3) checks against a real deploy
rather than a state that ran ahead of reality (the B-60 conflation — review F4).

### O3. Verify (Released → Verified)

After deploy, file the verification brief so the human can acknowledge real-world behaviour matches the
design (state-machine §6.1 — verifying is human-ack by default).

**Evidence-status line on the verify brief (B-560) — ALWAYS PRESENT, mechanical by construction.**
Before composing the brief, call `mcp__harmony__get_build_evidence_status({ task_id })` — the canonical
single-source-of-truth definition of whether this conducted ticket carries the build evidence we require
by Verified (test cases + all ACs checked + a PR/merge/deploy comment trail; an umbrella is exempt). Render
its result as a **one-line evidence-status line** prepended to the brief — never optional prose. Frame it
exactly like the B-516 release-brief risk signal: present on every verify brief, computed mechanically, so
a missing piece is surfaced on the brief the human accepts (it does NOT block accept — it informs it):

- `complete && !is_umbrella` → `✓ Evidence: complete (N test cases, M/M ACs checked, comment trail present)`
- `is_umbrella` → `Evidence: N/A (umbrella — carried by children)`
- otherwise → `⚠ Evidence incomplete: <missing joined by ", ">` (e.g. *"⚠ Evidence incomplete: test cases, 2 unchecked acceptance criteria"*)

(If incomplete and the build genuinely had its own work, land the missing evidence first — record the test
cases via `manage_test_cases`, check the ACs via `manage_acceptance_criteria` — then recompute the line.)

```
mcp__harmony__compose_brief({
  task_id, reason: "verification-ack-pending", pending_activity: "verifying",
  doc: { decide: "Does production behaviour match the design?", items: [{ kind: "decision", text: "Acknowledge verified", recommendation: "verify once confirmed" }] }
})
```

On the human's **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept" })` advances
Released→Verified (terminal-positive).

**Land the verify result on the ticket (B-560) — NON-OPTIONAL.** Immediately after the accept, comment
the verify outcome so the ticket carries the closing leg of the build→release→verify trail as durable
evidence:

```
mcp__harmony__add_comment({ task_id, content: "Verified — production behaviour matches the design (human-acked <date>)." })
```

**Drain any remaining rollup items (B-585, B-641) — if not already drained at the release gate (O2).**
Any out-of-scope items surfaced this run (including during verify) that weren't fix-first'd must be **drained
to a terminal outcome** — **fix-inline / fold-into-existing** (an AC / scope-item or `subsume_task`, **not a
bare comment**) **/ drop-with-reason / file-a-ticket**; nothing persists as a note — in ONE consolidated
**"Follow-ups rollup"** comment, followed by **triage-and-consolidate** (`find_related_tickets` → fold/dedupe
over mint; a `defer-with-trigger` → a fold or a **low-priority backlog ticket with the trigger in its body**)
per `skills/harmony-shared/disposition-discipline.md`. (Skip if nothing surfaced, or it was already drained +
audited at O2.)

Report completion.

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
