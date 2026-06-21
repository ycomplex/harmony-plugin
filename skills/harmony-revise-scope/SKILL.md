---
name: harmony-revise-scope
description: Draft a "revise scope / back up" reconciliation for a ticket whose downstream gate revealed the upstream spec was scoped too narrowly — back the run up to an earlier discovery gate (clarify/decompose/design) and re-run it against the real scope. Triggers on "harmony revise-scope B-123", "back up B-123 to re-clarify", "the scope grew — re-decompose B-123", a `revise-scope`/"back up" verb at a conductor gate pause, or being delegated by harmony-conduct when iterate feedback reveals the upstream scope grew. Drafts a concrete reconciliation brief (target gate + broadened scope + supersede-list vs keep-list) for the human to accept or reject.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Revise-Scope (B-519)

The mid-run **"revise scope / back up"** flow for the opinionated-mode conductor. When a *downstream*
discovery gate's discussion reveals the *upstream* spec was scoped too narrowly, the run must back up to an
earlier discovery gate and re-run it against the real scope. This skill is the agent that **drafts a concrete
reconciliation** and files it as a `revise-scope-review` brief so a human can **accept** (execute the back-up)
or **reject** (no-op). It is the **stale-patch "agent proposes, human disposes" pattern applied to the
discovery phase** (sibling to `harmony-stale-patch`), but a *different* trigger, a *different* brief reason,
and entry points stale-patch lacks.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## The contract this skill obeys

1. **Human-DECIDED — executes only on a human accept (contract-1).** The back-up may be **RAISED** by either
   the human or the agent, but it **EXECUTES only on a human accept**. This skill never calls `advance_workflow`
   (the state revert) without a human accept. The agent may *propose* a back-up — it never
   reverts state on its own. The honest trigger is **"human-decided," not "human-initiated."**
2. **Supersede, never delete.** On accept, the invalidated gate decisions are **superseded** (with the revised
   upstream decision as successor) — never edited or deleted. The Decision Trail is preserved.
3. **Supersede ONLY what the scope change actually invalidates.** The decisions for unaffected sub-tracks are
   **kept**. The drafted brief lists both (supersede-list vs keep-list) so the human can see exactly what the
   back-up touches.

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
mismatch), and the work done so far. The ticket should be at a discovery-phase state (`Decomposed` or
`Designed`) with an active downstream brief; if it is already at the earliest discovery state (`Idea`) there
is nothing to back up to — say so and stop.

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
necessary:

- the broadened scope changes **what the ticket fundamentally is** (the spec itself) → target **clarify**
  (revert to `Clarified`).
- the spec is fine but the broadened scope changes **how the work splits** (the decompose decision) → target
  **decompose** (revert to `Decomposed`).
- the spec and the split are fine but the broadened scope invalidates a **design sub-track** decision → target
  **design** (revert to `Designed`).

Honour an explicit `--to <gate>` if it is **no earlier** than the minimal target (a human may choose to back
up further); if `--to` names a gate *forward of* the minimal target, that target is insufficient — say so and
recommend the minimal one.

Then, from the gate decisions in step 1, split them into:
- **supersede-list** — the Accepted decision(s) the scope change actually invalidates (the target gate's
  decision and any downstream decisions that depended on the too-narrow scope).
- **keep-list** — the decisions for unaffected sub-tracks, preserved (the "supersede only what's invalidated"
  precedent — quick re-accept of unaffected sub-tracks).

### 4. Draft the revised upstream decision(s)

Draft the *content* of the revised upstream gate decision(s) that capture the broadened scope — concrete
enough that the human can say yes/no — but do **NOT** author them yet (the human applies on accept, step 6).
The draft is the new spec / decompose / design decision the re-run will start from.

### 5. Compose the revise-scope-review brief

File the reconciliation as a brief with the new `revise-scope-review` reason. Set `pending_activity` to the
`revising-*` activity that lands at the target milestone (the back-edge the re-run uses):

| target gate | `revising-*` activity | lands at milestone |
|---|---|---|
| clarify | `revising-clarifying` | `Clarified` |
| decompose | `revising-decomposing` | `Decomposed` |
| design | `revising-clarifying` / `revising-decomposing` (whichever earliest milestone the scope needs) | that milestone |

(Backflow semantics: a `revising-X` activity lands at the milestone X produces. The Phase-1 web migration
seeds the discovery-phase back-edges — `Decomposed→revising-clarifying→Clarified`,
`Designed→revising-clarifying→Clarified`, `Designed→revising-decomposing→Decomposed` — so `advance_workflow`
validates them. **This skill's `advance_workflow` hard-errors until that migration is deployed** — promote in
lockstep.)

The brief MUST name: the **target upstream gate**, a **one-paragraph broadened-scope summary**, the
**supersede-list** (accepted decisions to be superseded), and the **keep-list** (decisions kept — unaffected
sub-tracks).

```
mcp__harmony__compose_brief({
  task_id,
  reason: "revise-scope-review",
  pending_activity: "revising-clarifying",   // or "revising-decomposing" — the back-edge to the target
  doc: {
    decide: "Back B-123 up to re-clarify against the broadened scope (the design gate revealed the spec was too narrow)?",
    recommend: { text: "Revert to Clarified and re-run decompose+design against the real scope", confidence: "low" },
    why: [
      "The design-gate discussion grew the scope from X to X+Y",
      "The accepted clarify spec + no-split decompose decision assume the narrow scope",
      "Re-running forward authors fresh downstream decisions against the broadened scope"
    ],
    items: [
      { kind: "decision", text: "Revert to Clarified; supersede the clarify spec + decompose decision; keep the unaffected product-design sub-track", recommendation: "accept" }
    ]
  }
})
```

`compose_brief` sets `awaiting_human_input=true` + `awaiting_human_reason='revise-scope-review'`, so the
ticket surfaces in the human's queue with this decision. The §3.2 lint applies as usual.

> **Agent-proposed case (raise-path 3):** the brief surface is **identical** — the human accepts a
> conductor-proposed back-up through the SAME accept path as any other recommendation. There is no separate
> UX for the agent-proposed case.

### 6. Display + resolve

Show the rendered `content` verbatim. On the human's command:

- **accept** → execute the back-up, in this order (supersede → revert, so the final guard pass lands the
  ticket clean):
  1. **Author the revised upstream decision(s)** as successors (`mcp__harmony__record_decision` — the revised
     clarify spec / decompose / design decision capturing the broadened scope), and
     `mcp__harmony__supersede_decision` **each** decision in the supersede-list, pointing it at the new
     successor. This preserves the Decision Trail; the keep-list is left untouched.
  2. **Revert state via the back-edge:** `mcp__harmony__advance_workflow({ task_id, activity:
     'revising-clarifying' | 'revising-decomposing' })`. The DB guard then, in the same pass,
     **auto-clears the orphaned active downstream brief** (the B-482 reconciliation guard — direction-agnostic,
     closes any active brief on a state change) **AND auto-clears the `stale` flag** that superseding this
     ticket's own gate decisions would otherwise self-set (the Phase-1 guard extension clears `stale`/`stale_ref`
     on a `revising-*` backflow). So this skill does **NOT** manually clear the brief or the stale flag — the
     guard does both for free. (Order matters: supersede first, then revert, so the final guard pass leaves the
     ticket clean.)
  3. **Report** the ticket is now at the target discovery milestone (e.g. `Clarified`), the brief is cleared,
     ONLY the listed decisions were superseded, and it is **ready to re-conduct forward** against the
     broadened scope (`/harmony-plugin:harmony-conduct B-123` re-runs from the target gate, authoring fresh
     downstream decisions).

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

### 7. Report

State the outcome: either **accepted** (ticket reverted to <target milestone>; brief cleared; these decisions
superseded; ready to re-conduct forward) or **rejected** (no-op; run untouched at its current gate; the
feedback is addressed in-gate). Either way, name the target gate considered so the human has the audit trail.
