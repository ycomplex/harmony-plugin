---
name: harmony-revise-scope
description: Draft a "revise scope / back up" reconciliation for a ticket whose downstream gate revealed the upstream spec was scoped too narrowly — back the run up to an earlier discovery gate (clarify/decompose/design) and re-run it against the real scope. Triggers on "harmony revise-scope B-123", "back up B-123 to re-clarify", "the scope grew — re-decompose B-123", a `revise-scope`/"back up" verb at a conductor gate pause, or being delegated by harmony-conduct when iterate feedback reveals the upstream scope grew. Drafts a concrete reconciliation brief (target gate + broadened scope + supersede-list vs keep-list) for the human to accept or reject.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Revise-Scope (B-519, B-529)

The mid-run **"revise scope / back up"** flow for the opinionated-mode conductor. When a *downstream*
discovery gate's discussion reveals the *upstream* spec was scoped too narrowly, the run must back up to an
earlier discovery gate and **re-run it natively** against the real scope. This skill is the agent that
**drafts a concrete back-up proposal** and files it as a `revise-scope-review` brief so a human can **accept**
(execute the back-up) or **reject** (no-op). It is the **stale-patch "agent proposes, human disposes" pattern
applied to the discovery phase** (sibling to `harmony-stale-patch`), but a *different* trigger, a *different*
brief reason, and entry points stale-patch lacks.

> **Input-state principle (B-529).** A revise-scope revert lands at the re-targeted gate's **INPUT** state and
> hands off to a **NATIVE re-run** — the revised upstream decision is authored through that gate's OWN surface,
> **NOT folded into the revise-scope brief**. The landings are **clarify→`Proposed`, decompose→`Clarified`,
> design→`Decomposed`** (each gate's input, not its output). This skill only **supersedes** the invalidated
> decisions and reverts; it does **not** author the revised decision — the next `harmony-conduct` re-runs the
> target gate to author it fresh.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## The contract this skill obeys

1. **Human-DECIDED — executes only on a human accept (contract-1).** The back-up may be **RAISED** by either
   the human or the agent, but it **EXECUTES only on a human accept**. This skill never calls `advance_workflow`
   (the state revert) without a human accept. The agent may *propose* a back-up — it never
   reverts state on its own. The honest trigger is **"human-decided," not "human-initiated."**
2. **Supersede, never delete.** On accept, the invalidated gate decisions are **superseded** — never edited or
   deleted. The Decision Trail is preserved. The revised upstream decision is authored later, by the gate's own
   native re-run (not by this skill), so the supersede here does not point at a successor this flow created.
3. **Supersede ONLY what the scope change actually invalidates.** The decisions for unaffected sub-tracks are
   **kept**. The drafted brief lists both (supersede-list vs keep-list) so the human can see exactly what the
   back-up touches.
4. **Never silently orphan children (B-473).** A revert that **crosses the decompose gate** — a target of
   **clarify** (→`Proposed`) or **decompose** (→`Clarified`), landing *before* `Decomposed`, which supersedes the
   decompose decision that created this ticket's children — must dispose of those children **explicitly and
   recoverably**, never leave them orphaned under a re-gated parent. Two tiers: **auto cancel+archive**
   work-less children; **block + require an explicit per-child disposition** (**drop** / **reparent** /
   **abort**) when any child has work. Each end-state follows the canonical ticket-disposition convention
   (`skills/harmony-shared/ticket-disposition.md`): **drop** = cancel-then-archive (recoverable, `archived:
   true`, never a delete); **reparent** keeps the child live; **abort** abandons the revert (NOT a disposition).
   A **design**-target revert lands at `Decomposed` with the decompose decision intact, so it does NOT cross the
   gate and does NOT trigger this guard.

## Three ways it gets RAISED; one authority DECIDES it (human accept)

This skill produces the same drafted brief regardless of who raised it:

1. **Human, standalone:** `/harmony-revise-scope <ticket> [--to <gate>]` (sibling to `harmony-stale-patch`).
2. **Human, at a gate pause:** the human types a `revise-scope`/"back up" verb at a `harmony-conduct`
   controlled gate pause → the conductor delegates here.
3. **Agent-proposed (esp. on iterate):** while drafting or iterating a downstream brief, the conductor (or a
   gate skill) recognizes the human's feedback (or its own analysis) materially grew the scope — and the
   honest move is to back up a phase rather than cram the broadened scope into the current gate. It surfaces a
   revise-scope **recommendation**, and the human **accepts it exactly like any other recommendation** (same
   accept verb, same brief surface). This is NOT the system deciding — it ADDS a human decision; it does not
   remove one.

`--to <gate>` (optional) names the target discovery gate; one of `clarify` / `decompose` / `design`. If
omitted, infer the **minimal** target the scope change requires (see step 3).

## Flow

### 1. Load the run + its gate decisions

`mcp__harmony__get_task({ task_id })`. Read the current `workflow_state` and `workflow_activity`, the active
brief (`awaiting_human_input` / `awaiting_human_reason` — the downstream brief that surfaced the scope
mismatch, **if any**), and the work done so far.

**Step-1 guard — the accepted source states depend on the TARGET gate** (`--to`, or the minimal target
inferred in step 3). Two phases of source are accepted: the discovery phase (`Decomposed` / `Designed`) for
any target, and — new in **B-609** — the build phase (`Planned` / `Built`) for a **design target only**:

- **`--to design`** (revert to **`Decomposed`**): accept a source of `Decomposed`, `Designed`, **`Planned`, or
  `Built`**. The build states are the build-time "the design is wrong" case — a discovery surfaced *after* the
  plan/build gate that invalidates a design decision. The `revising-decomposing` back-edge lands at
  `Decomposed` from any of these (the B-609 web migration seeds `Planned`/`Built` → `revising-decomposing` →
  `Decomposed`; `Designed` already exists from B-519). NO guard/activity change — the `revising-%` stale-clear
  and the B-482 brief-clear apply for free.
- **`--to decompose`** (→`Clarified`) **or `--to clarify`** (→`Proposed`): accept ONLY `Decomposed` or `Designed`.
  A **build-state source (`Planned`/`Built`) is REJECTED** for these targets (AC4). Say so and give the
  **compose-pointer**: *"A build-state ticket can only back up `--to design` (to `Decomposed`) — the
  build-phase back-edge lands only at `Decomposed`. Back up `--to design` to `Decomposed` first, then revert
  further from `Decomposed` to re-decompose/re-clarify."* Build states are accepted **only** for a design
  target.
- **`Deployed` / `Verified` source:** this extension does **NOT** apply — post-release backflow is human-only
  (AC6). Say so and stop; do not draft a build-state revert from a deployed/verified ticket.
- **`Proposed` (or earlier) source:** already at the earliest discovery state — nothing to back up to. Say so and
  stop.

**Active-brief precondition (relaxed for build-state sources, B-609).** A `Decomposed`/`Designed` source is
expected to have an active downstream brief (the one that surfaced the scope mismatch). A **build-state source
does NOT require an active brief**: a mid-build discovery at `Planned` typically has **no** active brief (it is
agent-proposed — raise-path 3), and at `Built` the active brief is the `release-decision-pending` brief. Either
way the B-482 reconciliation on the revert auto-clears whatever active brief exists (and is a no-op if none),
so do not require or block on one when the source is a build state.

Pull the gate decisions the ticket already passed:

```
const refs = mcp__harmony__list_ticket_knowledge({ task_id })
// every Accepted gate decision THIS ticket authored — clarify spec, decompose split/no-split,
// design sub-tracks — with type + status. This is the surface the scope change may invalidate.
```

### 2. Query relevant domain knowledge

Per the discipline, query the domain(s) the broadened scope reaches
(`mcp__harmony__query_knowledge({ domain: [...], search: "<broadened subject>" })`) so the revised upstream
understanding is grounded in current knowledge, not just the in-session feedback. Surface any gap explicitly;
if a load-bearing gap blocks the revision, go research-first (`/harmony-plugin:harmony-research`) before
drafting.

### 3. Decide the target gate (the MINIMAL one) + the supersede-list vs keep-list

Pick the **earliest discovery gate the scope change actually requires reverting to** — no further back than
necessary. The revert lands at that gate's **INPUT** state (so the gate re-runs natively, B-529):

- the broadened scope changes **what the ticket fundamentally is** (the spec itself) → target **clarify**
  (revert to **`Proposed`** — clarify's input).
- the spec is fine but the broadened scope changes **how the work splits** (the decompose decision) → target
  **decompose** (revert to **`Clarified`** — decompose's input).
- the spec and the split are fine but the broadened scope invalidates a **design sub-track** decision → target
  **design** (revert to **`Decomposed`** — design's input).

(Each landing is the gate's INPUT, NOT its output — the gate re-runs natively from there and authors the
revised decision through its own surface. This is the B-529 input-state principle; the old behavior reverted
to each gate's output and folded the revised decision into this flow.)

**Build-state source for a design target (B-609).** The SOURCE need not be a discovery state. For a **design**
target the source may also be `Planned` or `Built` — the build-time "the design is wrong" case (a discovery
surfaced after the plan/build gate). The back-edge is still `revising-decomposing` and the landing is still
`Decomposed` (design's INPUT) — only the *from-set* widened to `{Decomposed, Designed, Planned, Built}`. The
minimal target from a build state is therefore **design** (the build-phase back-edge lands only at
`Decomposed`); a build-state source cannot target decompose/clarify directly (step-1 guard rejects it with the
compose-pointer — back up `--to design` first, then revert further from `Decomposed`).

Honour an explicit `--to <gate>` if it is **no earlier** than the minimal target (a human may choose to back
up further); if `--to` names a gate *forward of* the minimal target, that target is insufficient — say so and
recommend the minimal one.

Then, from the gate decisions in step 1, split them into:
- **supersede-list** — the Accepted decision(s) the scope change actually invalidates (the target gate's
  decision and any downstream decisions that depended on the too-narrow scope).
- **keep-list** — the decisions for unaffected sub-tracks, preserved (the "supersede only what's invalidated"
  precedent — quick re-accept of unaffected sub-tracks).

### 3a. Child disposition — only when the target crosses the decompose gate (B-473)

A target of **clarify** (→`Proposed`) or **decompose** (→`Clarified`) reverts the ticket to *before* `Decomposed`,
superseding the decompose decision that **created** this ticket's children — so those children would be
orphaned. (A **design** target lands at `Decomposed` with the decompose decision intact, so it does **not**
cross the gate — skip this step.)

When the target crosses the gate, read the children and classify them by whether they have work:

```
const children = mcp__harmony__list_subtasks({ task_id })   // returns kanban `status`, NOT workflow_state
// "has work" lives in workflow_state, which list_subtasks does NOT return — so read each non-archived child:
for (const child of children) {
  const c = mcp__harmony__get_task({ task_id: child.id })   // c.workflow_state, c.archived
}
```

A non-archived child **has work** iff `workflow_state ∉ {Captured, Proposed}` (a gate decision was made on it) OR
it has ≥1 non-archived child of its own. Partition into **work-less** (Tier 1) and **work-bearing** (Tier 2);
the brief (step 4) and the accept (step 5) act on this partition.

### 4. Compose the revise-scope-review brief

File the reconciliation as a brief with the new `revise-scope-review` reason. The brief carries only the
**back-up proposal** — it does **NOT** carry the revised decision content (that is decided later, at the
native re-run gate). Set `pending_activity` to the `revising-*` activity whose back-edge lands at the target
gate's **INPUT** state:

| target gate | `revising-*` activity | lands at (INPUT) |
|---|---|---|
| clarify | `revising-promoting` | `Proposed` |
| decompose | `revising-clarifying` | `Clarified` |
| design | `revising-decomposing` | `Decomposed` |

(Backflow semantics, B-529: each `revising-*` activity lands at the re-targeted gate's INPUT state — the
milestone the gate re-runs FROM, not the one it produces. `revising-promoting` lands at `Proposed` (the state the
forward `proposing` activity — named `promoting` when this edge was minted — produces), so it is **not** named
after a discovery gate — see the docs note below. The web migration seeds the back-edges — `revising-promoting` is the Phase-1 edge for clarify
(`{Clarified,Decomposed,Designed}→revising-promoting→Proposed`); decompose's `{Decomposed,Designed}→
revising-clarifying→Clarified` and design's `Designed→revising-decomposing→Decomposed` already exist from
B-519 — so `advance_workflow` validates them. **This skill's `advance_workflow(revising-promoting)`
hard-errors until that migration is deployed** — promote in lockstep, web migration first.)

The brief MUST name: the **target upstream gate**, a **one-paragraph broadened-scope summary**, the
**supersede-list** (accepted decisions to be superseded), and the **keep-list** (decisions kept — unaffected
sub-tracks). It does NOT contain the revised decision's content.

**Child disposition (when the target crosses the decompose gate, §3a).** The brief MUST also state the
disposition of this ticket's children:
- **Tier 1 — no child has work:** state that the back-up will **auto cancel+archive** the N work-less children
  (advance_workflow `cancelling`, record the reason in this revise-scope resolution, then archive — recoverable).
  No per-child input needed.
- **Tier 2 — ≥1 child has work:** **list each work-bearing child** (visual ID + title + `workflow_state`) and
  **gate the accept** on an explicit per-child disposition — **drop** (cancel+archive — discard the child's
  work; recoverable), **reparent <new-parent>** (move the work; child stays live), or **abort** (abandon the
  revert). The accept does **not** execute until every work-bearing child has a disposition.

Author the brief per `skills/harmony-shared/brief-authoring.md` §Auxiliary briefs — it inherits the
shared core and the legibility contract. Consult it; do not restate it.

```
mcp__harmony__compose_brief({
  task_id,
  reason: "revise-scope-review",
  pending_activity: "revising-promoting",   // the back-edge to the target gate's INPUT
                                            // ("revising-clarifying" for decompose, "revising-decomposing" for design)
  doc: {
    decide: "Back B-123 up to re-clarify against the broadened scope (the design gate revealed the spec was too narrow)?",
    recommend: { text: "Revert to Proposed and re-run clarify natively against the real scope", confidence: "high" },
    why: [
      "The design-gate discussion grew the scope from X to X+Y",
      "The accepted clarify spec + no-split decompose decision assume the narrow scope",
      "Re-running clarify natively authors a fresh spec through the clarify gate's own surface (not folded here)"
    ],
    items: [
      { kind: "decision", text: "Revert to Proposed and re-run clarify natively; supersede the clarify spec + decompose decision; keep the unaffected product-design sub-track", recommendation: "accept" }
    ]
  }
})
```

`compose_brief` sets `awaiting_human_input=true` + `awaiting_human_reason='revise-scope-review'`, so the
ticket surfaces in the human's queue with this decision. The §3.2 lint applies as usual.

> **Agent-proposed case (raise-path 3):** the brief surface is **identical** — the human accepts a
> conductor-proposed back-up through the SAME accept path as any other recommendation. There is no separate
> UX for the agent-proposed case.

### 5. Display + resolve

Show the rendered `content` verbatim. On the human's command:

- **accept** → execute the back-up, in this order (**dispose children → supersede → revert**, so the final
  guard pass lands the ticket clean). **This flow does NOT author the revised decision** — that is the job of
  the gate's native re-run (B-529 input-state principle), for ALL targets (clarify / decompose / design):
  0. **Dispose of the children FIRST (decompose-crossing targets only — §3a; skip for a design target):**
     - **drop** (Tier-1 auto, or a Tier-2 choice) — cancel-then-archive per
       `skills/harmony-shared/ticket-disposition.md`: `mcp__harmony__advance_workflow({ task_id: <child>, activity: 'cancelling' })`,
       record the reason in the resolution detail (the resolution IS the reason-capture — `advance_workflow` has
       no reason field), then `mcp__harmony__update_task({ task_id: <child>, archived: true })` — recoverable;
       never a delete (the accepted arch rule: a destructive cascade belongs to archive, not delete).
     - **reparent** (Tier-2 choice): `mcp__harmony__manage_subtasks({ task_id: <new-parent>, add: [<child>] })`
       — re-points the child's `parent_task_id` so its work survives the re-gate (the child stays live).
     - **abort** (Tier-2 choice): abandon the whole back-up — do **NOT** supersede, do **NOT** revert; the run
       stays at the current gate (same as reject). This is NOT a child disposition — it leaves the child untouched.
     Record each disposition in the resolution detail (the Decision Trail) — supersede-never-delete consistent.
  1. **Supersede the invalidated decisions:** `mcp__harmony__supersede_decision` **each** decision in the
     supersede-list (the target gate's decision + the downstream decisions the scope change invalidates).
     This preserves the Decision Trail; the keep-list is left untouched. There is NO successor to point at —
     the revised decision is authored later, by the target gate's native re-run, not here. (This skill no
     longer calls `record_decision`; superseding without an immediate successor is intentional.) Call it in
     **retire-mode (B-534): OMIT both `type` and `title`** — e.g.
     `mcp__harmony__supersede_decision({ old_decision_id: <id>, reason: "<why>" })`. That marks the old
     decision `Superseded` with `superseded_by=null` and creates NO successor decision (providing exactly one
     of type/title is rejected; provide both only to supersede-with-successor, which this flow never does).
  2. **Revert state to the gate's INPUT via the back-edge:** `mcp__harmony__advance_workflow({ task_id,
     activity })` with the activity that lands at the target's INPUT — `revising-promoting` (→`Proposed`) for a
     clarify target, `revising-clarifying` (→`Clarified`) for decompose, `revising-decomposing` (→`Decomposed`)
     for design. The DB guard then, in the same pass, **auto-clears the orphaned active downstream brief** (the
     B-482 reconciliation guard — direction-agnostic, closes any active brief on a state change) **AND
     auto-clears the `stale` flag** that superseding this ticket's own gate decisions would otherwise self-set
     (the B-519 guard branch matches `revising-%`, so `revising-promoting` is covered for free with no guard
     change). So this skill does **NOT** manually clear the brief or the stale flag — the guard does both for
     free. (Order matters: supersede first, then revert, so the final guard pass leaves the ticket clean.)
  2a. **Build-state source only — REPORT the dangling build artifacts (B-609).** When the source was a build
     state (`Built`, or `Planned` **with an open PR** — start-work opens the PR during the build), reverting to
     `Decomposed` orphans the in-flight build artifacts: the **open PR**, its **pushed branch**, and the local
     **git worktree**. This skill does **NOT** close PRs, delete branches, or remove worktrees itself (its
     `disallowed-tools` block `git push`/`git merge`, and it has no GitHub access). **Surface them explicitly**
     and instruct the human to **clean them up manually before the re-build** — list the PR (if known from the
     ticket/branch), the branch name, and the worktree path, and note that the native re-run will re-plan and
     re-build from the revised design, so the orphaned PR/branch/worktree should be closed/deleted to avoid a
     stale parallel build. (A discovery-source revert — `Decomposed`/`Designed` — has no build artifacts, so
     skip this report.) Automating this cleanup is tracked as the follow-up **B-614**.
  3. **STOP and report** the ticket is now at the target gate's **INPUT** state (`Proposed` for clarify,
     `Clarified` for decompose, `Decomposed` for design), the brief is cleared, ONLY the listed decisions were
     superseded, and it is **ready for `harmony-conduct` to re-run the target gate NATIVELY** — the revised
     decision is authored fresh through that gate's own surface (`/harmony-plugin:harmony-conduct B-123` picks
     up at the INPUT state and re-runs the target gate, then the gates forward of it). This skill does NOT
     author the revised decision and does NOT re-run the gate itself.

- **reject** → **no-op.** Abandon the draft. Resolve the revise-scope-review brief WITHOUT any state change,
  WITHOUT superseding anything, and WITHOUT recording a knowing-divergence (that record is only for
  stale-patch). The run is left **untouched** at its current gate with its original downstream brief intact.
  Use `mcp__harmony__resolve_brief({ task_id, command: 'defer', detail: 'revise-scope declined — addressing in-gate' })`
  ONLY to clear the revise-scope draft if the draft replaced the original brief; if the original downstream
  brief is still the active brief (you only *proposed* a back-up without composing over it), there is literally
  nothing to undo — just stop. **For the agent-proposed-mid-iterate case, the agent then addresses the
  feedback within the current gate instead of backing up.** One-shot; no recorded divergence, no future
  suppression.

  > Do NOT supersede, do NOT revert state, do NOT Park. Reject means the run continues exactly where it was.

- **edit** / **iterate** → revise the draft (target gate, scope summary, supersede/keep lists) and re-call
  `compose_brief` (updates in place, bumps `iteration`).

### 6. Report

State the outcome: either **accepted** (ticket reverted to the target gate's INPUT state — `Proposed` for clarify,
`Clarified` for decompose, `Decomposed` for design; brief cleared; these decisions superseded; ready for
`harmony-conduct` to re-run the target gate NATIVELY) or **rejected** (no-op; run untouched at its current
gate; the feedback is addressed in-gate). Either way, name the target gate considered so the human has the
audit trail. **When the source was a build state** (`Built`, or `Planned` with an open PR), also restate the
**dangling build artifacts** (open PR + pushed branch + worktree) the human must clean up manually before the
re-build (step 5 · 2a), and reference **B-614** (the follow-up to automate that cleanup).

## The input-state principle + the `revising-promoting` name (B-529)

A revise-scope revert lands at the re-targeted gate's **INPUT** state, never its output, so the gate re-runs
**natively** and authors the revised decision through its own surface:

| target gate | revert to (INPUT) | back-edge activity |
|---|---|---|
| clarify | `Proposed` | `revising-promoting` |
| decompose | `Clarified` | `revising-clarifying` |
| design | `Decomposed` | `revising-decomposing` |

This is why the revise-scope flow no longer authors the revised decision (the old behavior reverted to each
gate's *output* and folded the revised decision into the brief — accepting it off-flow, never through the
gate). Now it only supersedes + reverts; the decision is authored at the native re-run.

**Build-state source widening (B-609).** The table above maps each target gate to its INPUT and back-edge; the
SOURCE is independent of it. For a **design** target the source from-set is `{Decomposed, Designed, Planned,
Built}` — the back-edge (`revising-decomposing`) and the landing (`Decomposed`) are **unchanged**; only the
accepted source widened to include the build states (the build-time "design is wrong" case). For decompose/
clarify targets the source stays `{Decomposed, Designed}` (a build-state source is rejected — step 1).

**About the name `revising-promoting`.** The discovery back-edges are named after the activity that *produces*
the milestone they land at: `revising-clarifying`→`Clarified` (clarifying produces Clarified),
`revising-decomposing`→`Decomposed`. The clarify-target back-edge lands at **`Proposed`**, which the forward
**`proposing`** activity produces (that activity was named `promoting` when this edge was minted; B-637 renamed
the forward activity, and the `revising-*` back-edges deliberately keep their names) — so the back-edge is
`revising-promoting`, NOT named after a discovery gate.
This deliberately breaks the "every `revising-*` is named after a discovery gate" reading; `revising-promoting`
is the back-edge to clarify's INPUT (`Proposed`), and clarify itself re-runs there. It still carries the
`revising-` prefix, so the B-519 stale-clear guard (`revising-%`) + the B-482 brief-clear apply with no guard
change.

**Lockstep promotion.** The `revising-promoting → Proposed` edges ship in a harmony-web migration (Phase 1) that
must deploy **before** this skill — `advance_workflow(revising-promoting)` hard-errors until the edge exists.
Promote web first, then the plugin, in the same step (web before plugin), like B-519. The decompose/design
back-edges already exist from B-519, so only the clarify edge is new.
