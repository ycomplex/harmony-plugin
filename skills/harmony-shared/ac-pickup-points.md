# Where a clarified ticket can be picked up with its acceptance criteria still unfiled (B-747)

Clarify **originates** a ticket's happy-path acceptance criteria, but they land as a **side effect of an
accept** — not at compose time (B-648 rejected file-at-compose: it would persist unratified proposals on
defer/iterate). Any path where that accept happens somewhere the side effect *cannot* run leaves the
ticket clarified and criteria-less.

This file enumerates those paths. It lives here, beside the gate prose it constrains, so that adding a
route without updating the list is visible in review. **It is a floor, not a ceiling** — routes 2, 3 and 4
below were found by reading shipped prose rather than by being reported, which is the evidence that an
unenumerated route is the normal state of affairs. If you find another, add it.

| # | Pickup point | Why the criteria are unfiled | Covered by |
|---|---|---|---|
| 1 | **Clarify accepted in the browser, no session running** | The web is mechanical-only: `resolve_brief` advances state but cannot file criteria. A deliberate, documented deferral (B-648). | The design gate's filing-pass self-heal (`harmony-design-decide` §2b) |
| 2 | **A design brief accepted in the browser while a session IS watching** | `harmony-conduct` §4c case 1 classified design sub-tracks as a **pure** gate — "nothing further" — so the criteria writes its accept owes were dropped. B-648 made the accept side-effecting but left it listed as pure. | §4c case 1's side-effecting DESIGN branch |
| 3 | **A design brief accepted in the browser with NO session watching** — the daemon's normal path | §4c's consume branches only exist inside a live watch's poll-exit. A `--one-shot` leg exits at its pause; the daemon fires a **new** leg, which starts at loop step 1 and routes to the next forward gate. Nothing consumes the accept at all. | `harmony-conduct` §1b, the leg-start consume |
| 4 | **A ticket whose required sub-tracks skip the product track** | The self-heal sat inside the product track's own step, so it was never re-entered. | §2b now runs the self-heal on **every** sub-track |
| 5 | **A ticket clarified before criteria-at-clarify existed** (pre-B-648) | There is no proposed set to file. The gate must derive from the Accepted clarification, or refuse. | The refusal path — an elicitation round asking the human |
| 6 | **The build and verify gates themselves** — the last places an empty set can be caught | Not a leak so much as the backstop: whatever slipped through 1–5 arrives here. | The **floors**: `start-work` O3 and `finish-work` O3 pre-check `has_acceptance_criteria`; `tasks_workflow_guard` refuses `Planned→Built` and `Deployed→Verified` |

**B-797 update.** Routes 1 and 3 above are the exact specimen class B-797 closes structurally: `resolve_brief`
now defers the state advance itself for `clarification-draft` (and `decomposition-proposal` / `plan-draft` /
`design-decision-draft` on the product track) until a `consume_acceptance_event` commits it, so a web accept
with no session running leaves the ticket VISIBLY pending (`pending_acceptance_event_id` set) rather than
silently advancing with the criteria still unfiled. `harmony-conduct` §1c (the B-797 leg-start-consume) is
the generalized successor to §1b for these four reasons — see `gate-routing.md`'s B-797 section. §1b (this
file's route-3 fix) stays as-is for now: it is the self-heal RECOVERY when the snapshotted payload is not
(yet) in the structured shape §1c applies (a not-yet-migrated `compose_brief` call site) — see §1c's
`payload-unrecognized` branch.

## The shape these share

Every route is the same asymmetry: **a mechanical accept defers real work to an agent-side step, and that
step then never runs.** It is not specific to acceptance criteria — B-744's clarify-guard defect was one
gate earlier, and B-745 was the same shape in the other direction (a plugin-side flag whose clearing
surface did not exist). When adding any accept whose real work happens outside `resolve_brief`, ask: what
runs it when nobody is watching?

Two rules that follow, both learned the hard way:

- **Keep `gate-routing.md`'s pure/side-effecting column honest.** A row that says *pure* is a licence to
  resolve inline. Route 2 exists because that licence was wrong for a year.
- **A consume that only exists inside a live watch does not exist for the daemon.** Route 3 is the whole
  reason §1b runs on leg start rather than only on poll-exit.

## What the floors do and don't do

The floors at build and verify are **presence** tests — at least one criterion, checked state irrelevant.
They are deliberately **not** `all_acs_checked`: that stricter predicate is B-560's explicitly deferred
evidence test and would refuse every legitimately in-progress build.

Two ticket kinds are **exempt**, read from the same authority rather than re-derived: a **split umbrella**
(its evidence is carried by its children) and a **`decision-only`** ticket (its evidence IS the Accepted
decision knowledge). Both predate B-747 — they are the existing evidence-exemption set applied to a new
predicate, not new exemptions.

### Placement is load-bearing, not cosmetic

The floor lives in **two places doing two different jobs**, and collapsing them is a silent regression:

| Placement | Job | Fires |
|---|---|---|
| `start-work` O3, at the **very top** | prevents the **work** | before a worktree exists |
| `tasks_workflow_guard`, on the `Planned→Built` edge | prevents the **escape** | after the build has run |

B-747 shipped with the prose check sitting next to the `advance_workflow` at the *end* of O3. Every
presence-only assertion passed, and a criteria-less ticket still did a full build — worktree, implementation,
commit, push, PR — before being refused. The floor recorded the waste instead of preventing it, which is the
opposite of why B-698 (1,358 lines against a single-button criterion) motivated it.

`start-work.contract.test.ts` now asserts the **order** — pre-check before worktree before advance — because
a presence assertion structurally cannot tell a start-of-build check from a late one.

### Two exemptions were not enough — enumerate the traffic, not just the exemptions

B-560 deferred this guard citing *"risk of false-blocking legitimate evidence-light tickets."* B-747's design
answered that by pointing at the two existing exemptions. It was **incomplete**: the E2E guard fixtures walk
umbrella **children** — leaf tickets, correctly non-exempt — to `Verified` without criteria, and the floor
refused seven of them. The nightly caught it; no PR gate could, because `E2E Nightly` runs on `event: schedule`.

The transferable rule: **when adding a floor, enumerate the legitimate traffic it will refuse.** Reasoning
forward from the exemption set you already thought of will miss exactly the cases you did not.

## Where the predicate lives

**One** definition, in SQL: `task_criteria_floor_status(p_task_id)` returning
`(has_criteria, is_exempt, exempt_reason)`. The substrate guard calls it directly; `get_build_evidence_status`
reads it for `has_acceptance_criteria`; the web's verify-brief pre-check reads it too. The plugin's read
degrades to a local computation on SQLSTATE **42883 only** (the function is absent because the environment
predates the migration — which the daemon hits by default, running `HARMONY_PLUGIN_POSTURE`
(defaulting to `main`) against `HARMONY_TARGET=prod`). Every other error propagates: a floor that opens when it malfunctions is not a
floor.
