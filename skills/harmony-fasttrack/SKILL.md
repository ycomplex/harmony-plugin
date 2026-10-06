---
name: harmony-fasttrack
description: Fast-track a small, eligible ticket through fix -> PR -> record from any interactive Claude Code session, without an orchestrator. Triggers on "fast-track B-123", "harmony fasttrack B-123", or picking up a small ticket that clearly needs no orchestration. Four phases: Check (the same 5-item eligibility floor harmony record --check uses), Plan-lite (an inline <=3-step plan the human confirms in-session), Build (worktree -> fix -> scope-guard -> PR-open, stop), Record (a second invocation after a human merge, taking an --attest-walk sentence and calling the same runRecordedWalk core harmony record uses).
allowed-tools: mcp__harmony__* Read Edit Write Bash Glob Grep
---

# Harmony Fast-Track

Fast-tracks a small, eligible ticket end to end — fix, open a PR, and (on a later invocation) record
the gate-walk trail — from any interactive Claude Code session, with **no orchestrator** in the loop.
It exists for the common case `harmony record --check`/`harmony record` already serve by hand: a
small, already-clear ticket that needs a real fix but carries none of the risk an orchestrated
`harmony conduct` run exists to manage. This skill glues the same three mechanisms — eligibility
check, build, recorded walk — into one flow, minus the merge and the verify attestation, which stay
human.

## Flow

### 1. Check phase (always first, before any work)

Resolve the target ticket (`mcp__harmony__get_task`). Gather evidence: the ticket's own
`field_values.build_pr` / `field_values.prerequisite_pr` if either is already set (unlikely this
early — there is usually no PR yet), else fall back to the ticket's own title/description text as
the "evidence" for the eligibility read. Run the same `evaluateEligibility`
(`src/tools/record-eligibility.ts`) `harmony record --check` uses, and print each item's verdict via
the SAME shared formatter, `formatEligibilityLine('harmony fasttrack check', ticket, item)` — never a
second, hand-rolled line format that could drift from `record --check`'s own output shape.

**Per AC9: any `fail` verdict refuses before any work begins.** A failing item (multi-repo, a
migration path, a gated risk class, or a summary that isn't single-sentence-statable) means this
ticket is not fast-track material — stop here and name `harmony conduct <ticket>` as the escalation
to the full, orchestrated flow.

**The verify-walk item (`unattested`) does NOT refuse here — it is deferred to the Record phase.**
There is no verify walk yet (no fix exists), so printing it as `UNATTESTED` and moving on is correct,
not a bug: the Record phase (step 4) is where a human attestation is actually required.

### 2. Plan-lite phase

Draft an inline plan of **at most 3 steps**, derived from the ticket's own title/description text —
no brief, no `compose_brief` call. This is deliberately lighter than the conductor's plan gate: there
is no plan-draft brief to accept, because the ticket already read as small and clear enough to pass
Check. Present the plan to the human and **wait for their explicit confirmation in-session** before
touching the repo. This is the **one hard pause** in the whole skill before any repo work happens —
never auto-proceed past it.

### 3. Build phase

Once confirmed, reuse `skills/start-work/SKILL.md`'s **O3** section **by reference** — worktree
creation, implementation, tests, commit, push, PR-open all follow that section's mechanics verbatim.
Do not duplicate that prose here. This skill adds exactly **two deltas** on top of O3:

- **No plan-brief checklist.** O3 opens by reading a materialized plan-accept checklist
  (`list_checklist_items`) as its authoritative work list, because a live plan gate populated one.
  Here there is no `plan-draft` brief — step 2's plan-lite confirmation **is** the human's go-ahead.
  Build straight from the plan-lite steps the human just confirmed.

- **The scope guard + eligibility re-check, run immediately before `gh pr create`** (per AC10/AC3,
  both filed on this ticket). Before opening the PR:
  1. Re-run the **four auto-derived** eligibility items (multi-repo, migration, risk-class,
     single-sentence) against the build's **real** changed paths — `git diff --name-only` against the
     merge base — rather than the Check phase's pre-work guess.
  2. Run `evaluateScopeBudget` (`src/tools/fasttrack-scope.ts`) against `git diff --numstat`, using
     any `.harmony/project.yml`-declared override (`getScopeBudget`) when present, else
     `DEFAULT_SCOPE_BUDGET`. (`harmony fasttrack scope-check` wraps exactly this read.)

  **If either check now fails: do NOT open the PR.** Report the overage/verdict, **leave the branch
  and its commits intact** (per AC6 — the work is not discarded, just not shipped through this skill),
  and name `harmony conduct <ticket>` as the escalation. A ticket that looked small at Check but grew
  past the scope budget or tripped a risk class while being built needs the full orchestrated flow,
  not a fast-tracked PR.

  **If both pass:** open the PR and record `build_pr` on the ticket exactly as O3 does, then **STOP**
  — never merge, never record, in the same invocation (per AC4). The merge is the human's; recording
  is this skill's own separate, later invocation (step 4).

### 4. Record phase

A **second invocation** of this skill (or an equivalent `--record` flag — document both as the same
trigger) picks up **after** the human has merged the PR. Determine which phase to run **purely from
the ticket row** (per AC8 — no carried session state, since nothing guarantees the same session comes
back):

```
mcp__harmony__get_task({ task_id })
gh pr view <pr_number> --json state,mergedAt
```

reading `pr_number` off `field_values.build_pr`.

**Refuse with a named reason (per AC5) when:**
- `field_values.build_pr` is absent — nothing to record yet; the ticket hasn't reached Build.
- The PR's `state !== 'MERGED'` — the human hasn't merged it yet.
- No `--attest-walk` sentence (or equivalent human-supplied attestation) was supplied this
  invocation — a recorded walk's verify-walk item is **never** auto-passed.

**Otherwise**, take the human's attestation sentence and call the **same** `runRecordedWalk` core
(`src/tools/record-walk.ts`) `harmony record` uses, passing:
- the merged PR's URL as the evidence link (`gatherEvidenceSignals` resolves its repo/paths via `gh`);
- the human's sentence as `attest_walk`.

**Never invent a summary.** If the ticket's own text doesn't already read as one clean sentence, ask
the human for one rather than synthesizing one to force the single-sentence-shape check to pass.

**The ask-first rule for plugin/web targets.** Before running the Record phase against a `plugin/` or
`web/` target, print this line verbatim (`docs/orchestrating-a-milestone.md` §13 step 9, founder
standing rule 2026-09-23):

> "the workspace repo may be recorded without asking; for `plugin/` and `web/` the orchestrator ASKS the founder before recording, rather than silently taking the slow track."

This skill does **not** decide on its own whether to proceed — it surfaces the rule and waits for the
human's go-ahead in-session before calling `runRecordedWalk` against either of those two targets. The
workspace repo itself carries no such pause.

## No conduct-session breadcrumb

This skill **deliberately does not write** a `~/.harmony/conduct-sessions/<session>.json` breadcrumb,
unlike `harmony-conduct`. At PR-open the ticket sits in a state (`Captured`-adjacent-shape — no
children, flag down) that the B-870 turn-end stop gate's `isCleanRowShape` does not recognize as a
sanctioned stop point for a *conducted* ticket. Writing a breadcrumb here would make the stop gate
treat this skill's own correct, deliberate stopping point (end of Build, end of Record) as an
incomplete conduct session and incorrectly block it. **Do not "fix" this by adding a breadcrumb** — a
future reader who notices the absence should read this paragraph, not add one back.
