---
name: harmony-conduct
description: Drive one ticket through the gate sequence end to end, pausing at every gate for the human's decision. Triggers on "conduct B-123", "harmony conduct", "run B-123 through the flow", "drive this ticket to verified". The controlled-only conductor — generalizes harmony-next's single-step pickup into a continuous loop, with the SAME human decision points; it orchestrates the plumbing BETWEEN gates, never the decisions AT them.
allowed-tools: mcp__harmony__* Read Grep Glob TodoWrite
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Conduct (controlled-only conductor — B-458 phase 2a)

The conductor loop. Given a ticket and a "go", it drives the whole gate sequence
(clarify → decompose → design → plan → build → release → verify) by delegating to the existing gate
skills **in lifecycle order**, automating the drudgery of hand-invoking `/harmony-plugin:harmony-next`
at each step into one continuous loop.

`harmony-conduct` is the **generalization of `harmony-next`** (agent-model §5): instead of pulling one
awaiting item and stopping, it loops over the forward path. It is **not** a new decision surface — every
gate still drafts and `compose_brief`s exactly as today, and the human still answers through the existing
brief surface (web UI Accept/Defer/feedback, or the gate skill's accept/edit/iterate).

## The contract this skill obeys (founder-locked — do not relitigate)

1. **The loop NEVER skips a human decision.** It surfaces every gate's brief and **PAUSES**. This whole
   capability exists to *replace* the `start-work`/`finish-work` auto-pilot — a loop that auto-advances
   past a decision rebuilds exactly that. There is no "this looks minor, I'll just run it." Ever.
2. **It orchestrates only the *plumbing between* gates, never the *decisions at* them.** The conductor
   delegates to a gate skill, lets that skill draft + compose the brief, then **stops and hands the
   decision to the human.** The conductor itself NEVER calls `resolve_brief` — accept/defer/edit is the
   human's act (via the web UI or the gate skill). The conductor's job is only to *run the next gate* once
   the previous one is resolved.
3. **This is the controlled route, and it is the only route this skill offers.** There is no
   `--unattended`, no autonomy selector, no circuit-breaker, no risk signal here — those are B-458 phases
   2b/2c/2d and are explicitly out of scope. A bare invocation conducts the ticket fully controlled,
   pausing at every gate.

## State-driven and resumable — the loop's memory is the ticket row

The conductor holds **no state in the session**. The loop's entire memory is the ticket row
(`workflow_state`, `workflow_activity`, `awaiting_human_input`, `awaiting_human_reason`,
`awaiting_human_ref`, the `stale` flag, and the active brief). Re-running `/harmony-plugin:harmony-conduct
B-123` reconstitutes everything from `get_task` and resumes from the ticket's current state — whether the
previous session was closed, the human answered in the web UI, or the ticket advanced by some other path.
This works for the same reason `resolve_brief` is idempotent: each loop iteration is a pure function of
the ticket row, so it is **idempotent and stateless between pauses**. No new schema, no session file.

## Flow

### 1. Resolve mode + the target ticket

Call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the conductor drives the
opinionated-mode lifecycle (manual-mode projects use the normal board, not clarify→decompose→design→…).
A ticket id is **required** — `/harmony-plugin:harmony-conduct B-123`. (Conducting picks a *specific*
ticket to its terminal state; that is different from `/harmony-plugin:harmony-next`, which pulls whatever
is top of the queue.) If no ticket was named, ask for one and stop.

`mcp__harmony__get_task({ task_id })`. Note the starting `workflow_state` and report it: *"Conducting
B-123 from <state>. I'll pause at every gate for your decision."*

### 2. The loop

Repeat the following until a **TERMINAL** or **PAUSE** condition is reached (see step 5):

1. **Re-read the ticket, then render the progress overview.** `mcp__harmony__get_task({ task_id })` at the
   TOP of every iteration — never trust a cached copy. Read `(workflow_state, workflow_activity,
   awaiting_human_input, awaiting_human_reason, awaiting_human_ref, stale)`. **Immediately after the
   re-read, regenerate and render the progress overview from the ticket row** (see *The progress overview*
   below). This happens on **every** iteration so the checklist always reflects the just-read state.

2. **If the ticket is already awaiting a human decision → PAUSE immediately.** If `awaiting_human_input`
   is set, a gate has already drafted a brief and the ball is in the human's court. Do **NOT** run another
   gate on top of it (that would overwrite the one active brief — there is one active brief per task). Go
   to step 4 (Surface + pause). This is the resume case: a re-run that finds an unresolved brief surfaces
   it and waits.

3. **If the ticket is `stale` → PAUSE and route to the patch author.** A superseded knowledge decision
   has put the ticket out of sync (state-machine §6.4). This is a human decision, not a forward gate.
   Delegate to `/harmony-plugin:harmony-stale-patch <ticket>` (it drafts the `stale-patch-review` brief),
   then surface it and pause (step 4) — exactly as `harmony-next` does. The loop does not advance a Stale
   ticket past the patch decision.

4. **Otherwise, determine the next forward activity and RUN it** by delegating to the owning gate skill
   (state→activity map below). The gate skill queries knowledge, drafts the decision, and `compose_brief`s
   — setting `awaiting_human_input`. Then **PAUSE** (step 4 below): the loop does not continue past a fresh
   brief. *(Side-effecting note: `harmony-decompose` creates children on accept, and `finish-work` does
   the merge/deploy on accept — but those side effects happen at the human's accept, owned by the gate
   skill, NOT by the conductor. The conductor only invokes the gate skill to produce the brief, then waits.)*

### The state → activity map (the §6.1 forward path)

Branch on `workflow_state` to pick the next gate. This mirrors `harmony-next`'s routing table, walked
forward one state at a time:

| `workflow_state` | Next activity | Delegate to | Gate is… |
|---|---|---|---|
| Captured / Idea | clarifying | `/harmony-plugin:harmony-clarify <ticket>` | pure (accept = `resolve_brief`) |
| Clarified | decomposing | `/harmony-plugin:harmony-decompose <ticket>` | side-effecting (accept creates children) |
| Decomposed | designing | `/harmony-plugin:harmony-design-decide <ticket> --track <sub-track>` | pure per sub-track; serialized (one brief at a time) |
| Designed | planning | `/harmony-plugin:start-work <ticket>` | pure (accept = `resolve_brief`; the accept is "go" to build) |
| Planned | building | `/harmony-plugin:start-work <ticket>` | build work, then files `release-decision-pending` |
| Built | releasing | `/harmony-plugin:finish-work <ticket>` | side-effecting (accept → merge+deploy) |
| Released | verifying | `/harmony-plugin:finish-work <ticket>` (verify step) | side-effecting (observe prod); also the PR-less umbrella path |
| Verified | — | (none) | TERMINAL — loop ends |
| Parked / Cancelled | — | (none) | TERMINAL — loop ends |

**Designing is multi-sub-track and serialized.** `harmony-design-decide` runs ONE sub-track per
invocation and there is one active brief per task, so the design phase is several pause/resume cycles:
file product-design → pause → human accepts → loop re-reads (still Decomposed, no other sub-track
accepted yet) → file technical-design → pause → … The ticket only advances Decomposed→Designed when the
**last required** sub-track is accepted (the gate skill owns that completion check via
`list_ticket_knowledge`). The conductor does not decide which sub-tracks are required — it re-invokes
`harmony-design-decide` and lets the gate skill propose/serialize them. If the ticket is still Decomposed
after a design sub-track was accepted, that is the normal "more sub-tracks to go" case — keep looping.

**Designed → Planned → Built both delegate to `start-work`.** In opinionated mode `start-work` drives
*planning* (Designed→Planned, files a `plan-draft` brief) and *building* (Planned→Built, builds in a
worktree then files `release-decision-pending`). Invoke it for both states; it branches internally on
`workflow_state` (its step O1). After the plan is accepted (ticket → Planned), the next loop iteration
re-invokes `start-work`, which proceeds to build.

### The progress overview — a derived view, never session state

The human reading the loop sees the *current* gate at each pause, but needs an *overview*: where the baton
is in the whole run. Render that overview as a **Claude Code task list** via `TodoWrite`.

**It MUST be a derived view reconstructed from the ticket row, NOT session-held state.** The loop's only
memory is the ticket row (§"State-driven and resumable"); a session-held todo list would break
resumability and drift from the truth. So, on **every** iteration, **right after the `get_task` re-read in
step 1**, regenerate the list *from scratch* from the current `workflow_state` and call `TodoWrite` to
render it. Hold nothing between iterations. On a fresh re-run in a new session it must regenerate
**identically** from the ticket row — there is no carried state to consult.

**The checklist is the fixed forward path**, one item per phase, in lifecycle order:

```
clarify → decompose → design → plan → build → release → verify
```

Derive each item's status purely from `workflow_state` — map the state to the phase it is *in*, then:

- phases **before** the current phase → `completed`
- the current phase → `in_progress`
- phases **after** → `pending`

| `workflow_state` | Current phase (→ `in_progress`) |
|---|---|
| Captured / Idea | clarify |
| Clarified | decompose |
| Decomposed | design |
| Designed | plan |
| Planned | build |
| Built | release |
| Released | verify |
| Verified | — all `completed` (terminal) |
| Parked / Cancelled | mark phases through the last-reached one `completed`, leave the rest `pending`; the run is terminal |

For **Verified**, mark every item `completed`. For **Parked**/**Cancelled**, the run is terminal — the
list shows progress frozen where it stopped (no `in_progress` item). Keep it to this high-level phase map;
per-design-sub-track granularity is **not** required (if a `design` sub-track is mid-serialization you may
note it in the design item's text, but only if it stays a cheap, clean read of the ticket row).

This list is purely informational — it never drives a decision and never substitutes for the
brief-surface pause. It is regenerated, not mutated, so it can never disagree with the ticket row.

### 3. Run exactly one gate per iteration, then PAUSE

After delegating to a gate skill, **do not loop again on your own.** The gate has composed a brief and set
`awaiting_human_input` — the ball is now in the human's court. Go to step 4. The loop's forward motion is
gated on the human resolving each brief; that is the contract (§contract item 1).

### 4. Surface the brief + pause for the human's decision

Surface the active brief so the human can decide:

- `mcp__harmony__get_brief({ task_id })` and display the rendered `content` blob **verbatim** in a fenced
  block (it is already BLUF-formatted and lint-clean — do not re-summarise it). Note `iteration` if > 1.
- **Null brief on a `verification-ack-pending` umbrella (B-471):** `get_brief` can be **null** when
  `awaiting_human_reason = 'verification-ack-pending'` and `awaiting_human_ref.kind ===
  'umbrella-auto-verify'` — the trigger-surfaced **PR-less umbrella** (a decomposed parent the DB trigger
  auto-advanced Decomposed→Released once all children reached Verified; it set the flag but composed no
  brief). Do **not** choke on the missing brief. The `verifying` gate already routes to
  `/harmony-plugin:finish-work <ticket>` (per the map), which composes the verification brief first and
  then surfaces it. Recognise the umbrella by the `umbrella-auto-verify` marker on `awaiting_human_ref`.

Then **STOP and tell the human the ball is in their court.** State plainly: which gate this is, the
one-line decision (`doc.decide`), and how to answer —

> *"B-123 is at the **<gate>** gate, awaiting your decision: <doc.decide>. Accept / defer / give feedback
> in the web UI, or here. Re-run `/harmony-plugin:harmony-conduct B-123` after you've decided and I'll
> drive the next gate."*

**The conductor does not resolve the brief.** Accept/defer/edit/iterate is the human's decision, made
through the existing surface (the web UI's Accept/Defer, or the owning gate skill's accept/edit/iterate
path — `harmony-clarify`/`harmony-decompose`/`harmony-design-decide`/`start-work`/`finish-work` each own
their resolve, including the side effects: children-creation, merge+deploy, prod-observation). The
conductor *never* calls `resolve_brief` itself — doing so would be the system making the human's decision,
which is exactly what this program exists to prevent.

**If the human answers in this same session** (e.g. "accept", "looks good", or substantive feedback),
hand the resolution to the owning gate skill for that `awaiting_human_reason` (the gate skill performs the
accept/defer/edit and any side effects — same routing as `harmony-next`'s table). Once it reports the new
state, **resume the loop at step 2** (re-read the ticket, run the next gate). If the human steps away, the
loop is paused; a later `/harmony-plugin:harmony-conduct B-123` resumes from the ticket row.

### 5. Terminal conditions — when the loop ends (not pauses)

The loop **ends** (does not pause for resume) when, after re-reading the ticket at step 2:

- `workflow_state === 'Verified'` → done. Report: *"B-123 is Verified — conducted from <start state> to
  Verified."*
- `workflow_state === 'Parked'` or `'Cancelled'` → the human deferred/cancelled at a gate. Report where it
  parked and why, and stop. (A deferral authored its own `deferral` knowledge entry via the gate skill —
  the conductor does not author it.)

Everything else is a **pause**, not an end: the loop is always resumable from the ticket row.

## What this skill does NOT do (phase-2a scope guard)

- It does **not** auto-advance any gate. No `--unattended`, no autonomy level, no per-run delegation.
- It does **not** read the workspace Agent-Trust dial, raise a circuit-breaker, or compute a risk signal
  (B-458 phases 2b/2c/2d).
- It does **not** call `resolve_brief`, `record_decision`, or any write that makes a gate's decision — it
  delegates those to the owning gate skill, where the human's resolution lives.
- It does **not** edit code, commit, push, or merge — those are the build/release gate skills' jobs,
  invoked through the map.
