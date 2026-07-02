# Elicitation engine — the trigger-agnostic exchange contract (B-645 / B-550)

When a gate can't infer the human's intent, it interrogates it out through **rounds of questions
BEFORE drafting** — elicit → draft → (much lighter) approve, instead of draft-then-approve. This file
is the ONE behavioural contract every elicitation-running skill follows; the triggers (B-462
pre-draft-clarify, B-461 discuss, B-518 phase-split-probe) supply **only a `trigger` + context** and
inherit everything below. The substrate is `elicitation_exchanges` (one ACTIVE exchange per task,
append-only `rounds`); the tools are `start_elicitation`, `file_elicitation_round`,
`get_elicitation`, `conclude_elicitation`; the pure lints live in `src/elicitation/engine.ts`.

An exchange is an **interaction model within a gate** — it never advances `workflow_state`, and it
can run while a brief is active (a `discuss` exchange attaches via `brief_id`).

## When to elicit — intent-opacity relative to the KB

Elicitation fires when intent **can't be inferred from ticket + knowledge base**, or when an
inference needs the human's validation. NOT ticket length, NOT a form to complete. Always try KB
inference first (`query_knowledge` per `knowledge-discipline.md`) and interrogate **only the
residual**. Grounding rules:

- **Accepted knowledge only grounds inference.** Never build an inference on an Asserted entry.
- **An Asserted claim enters the dialogue only as an explicit validation candidate** — "I hold an
  unratified claim that X — confirm?" — which is also its ratification route.
- Mine **beliefs and intent, not slots**: the drivers of the ticket, the behaviour to be performed,
  any solution-shape already in the user's head. Forms get rubber-stamped too.
- **Cold start:** an empty KB must not become maximal interrogation of the least-invested user.
  Lead with your own best-effort inferences as validation candidates, gate depth by stakes, keep
  force-quit prominent from round one.

## The stakes-split turn rule

Split every question by how much a wrong answer steers the work:

- **Low-stakes residual → lead with the inference-validation.** `kind:'validate'` — statement +
  Confirm/Correct ("here's what I inferred — correct me"). Cheap for the human; framing
  contamination doesn't matter where the answer barely steers.
- **Load-bearing residual (drivers, non-goals, solution-shape) → open question FIRST, your
  candidate withheld.** `stakes:'load-bearing'` MUST be `kind:'open'` — the tool lint rejects a
  load-bearing validate. The human speaks before your framing can contaminate the answer, and the
  question can never render as a one-click confirm (the anti-rubber-stamp binding).

## Round discipline

- **≤ 5 questions per round** and **ONE plain-prose context line** framing the round. The
  `file_elicitation_round` lints enforce ≤5 / load-bearing-must-be-open / validate-needs-statement —
  fix the round, don't fight the lint.
- Filing a round hands the ball to the human: the task flags `awaiting_human_input` with reason
  `elicitation-round`. Then WAIT (arm the conductor watch where one is running) — never answer your
  own round.
- Don't front-load: ask the highest-leverage residual first and let the answers shape round N+1.

## Consuming answers

A web submit stamps `answers_submitted_at` and clears the task flag; the conductor watch classifies
this as **`answers-landed`** (get_task's `active_exchange` projection carries the marker; the
classification fires before `resolved`, so an exchange answer is never mistaken for a non-advancing
accept). On pickup:

1. `get_elicitation` — read the last round's `answers` (keyed by question id).
2. **Partial submits are legitimate.** A skipped question is signal, not an error: re-ask it
   re-framed in the next round if it's load-bearing, or let it go if the other answers already
   settle the residual. Re-asking the same question the same way is interrogation, not elicitation.
3. Decide: converged → conclude; more residual → file the next round (**filing IS the consume** —
   it clears the marker); force-quit requested (`force_quit_requested_at`) → the force-quit path.

## Convergence — agent-detected, a signal never a gate

The test: **"I can now confidently draft a brief that represents the user's intent."** Its concrete
correlate: you can state the ticket's **happy-path acceptance criteria and the human confirms them
without correction**. That correlate is a SIGNAL, never a completion gate — do not spend a round
chasing a ceremonial confirmation when you already have what you need. A wrong convergence call is
backstopped by the brief-iterate loop. On convergence: `conclude_elicitation('converged')`, draft
the brief, and present it with "What I learned from you" (the claims, badged by provenance).

## Force-quit — "best efforts, proceed"

The human can always cut the exchange short (`force_quit_requested_at`, or saying so directly).
Never argue for one more round. `conclude_elicitation('force-quit')`, **draft from what you have**,
and mint any load-bearing claims you had to assume with `claim_provenance:'force-quit'`. Force-quit
claims are QUARANTINED: they **never promote at their own brief's accept** (the DB disposal skips
them) and **never feed inference until later validated** — surface one as an explicit validation
candidate in a future exchange to ratify it.

## Emission — claims with provenance

Mint **ONLY the load-bearing claims that actually steered the brief** — not a transcript. Each is an
Asserted `record_decision` with:

- `claim_provenance`: `human-stated` (they said it) | `agent-inferred-human-validated` (your
  inference, confirmed) | `force-quit` (assumed under force-quit);
- `underwriting_brief_id`: the brief the claim underwrites — this coupling makes disposal
  mechanical: **accept promotes** human-grounded claims to Accepted (force-quit stays quarantined),
  **defer archives** all coupled Asserted claims (DB-side), **iterate prunes** (below).

**Mint-time dedupe:** search the KB (`query_knowledge`) before minting. A duplicate of an existing
entry becomes a **validation candidate, not a new entry** — confirm the existing entry instead of
minting a twin.

## Iterate-prune — claims must keep underwriting

On a brief **iterate** (in-place re-compose), some claims may no longer underwrite the reshaped
brief. Compute the **kept-set** — the claim ids that still underwrite — and pass it as
`underwriting_claim_ids` to `compose_brief`: coupled Asserted claims NOT in the list are archived
(`[]` archives all; omitting the param skips the prune). Never let a dropped claim ride into
promotion on a brief it no longer underwrites.

## Abandon re-entry

`conclude_elicitation('abandoned')` writes ONLY the exchange row. For a brief-attached (`discuss`)
exchange this deliberately leaves **the brief active with the task flag down** — the owning gate
skill's existing "brief already active" path re-composes it in place on re-entry, re-setting the
flag. Do not "helpfully" re-flag the task or resolve the brief at abandon time; re-entry owns that.
