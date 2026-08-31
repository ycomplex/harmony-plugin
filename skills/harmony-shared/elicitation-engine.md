# Elicitation engine — the trigger-agnostic exchange contract (B-645 / B-550)

When a gate can't infer the human's intent, it interrogates it out through **rounds of questions
BEFORE drafting** — elicit → draft → (much lighter) approve, instead of draft-then-approve. This file
is the ONE behavioural contract every elicitation-running skill follows; the triggers (B-462
pre-draft-clarify, B-461 discuss, B-518 phase-split-probe) supply **only a `trigger` + context** and
inherit everything below. The substrate is `elicitation_exchanges` (one ACTIVE exchange per task,
append-only `rounds`); the tools are `start_elicitation`, `file_elicitation_round`,
`get_elicitation`, `conclude_elicitation`, `submit_elicitation_answers`; the pure lints live in
`src/elicitation/engine.ts`.

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

**Terminal answers are echoed, not lost (B-462).** The web submit is the only surface that writes
`rounds[].answers` itself; when the human answers a round in the terminal, echo their answers via
`prior_answers` on your NEXT engine write — `file_elicitation_round` (when filing the following
round) or `conclude_elicitation` (at convergence/force-quit). Same `{verb, text?}` shape, keyed by
question id; the engine stamps each echo `via:'terminal'` and guards the write (last filed round
only; a web-submitted answer is never overwritten; verbs must fit the question kind — confirm /
correct / skip for a `validate`, answer / skip for an `open`). The rounds history is the provenance
trail — an exchange answered at the terminal must read identically to one answered on the web.

**When the next move isn't decided yet, RECORD the answers on their own (B-893).** Both
`prior_answers` paths are consumes — they ride a write that also files the next round or concludes,
and both CLEAR `answers_submitted_at`. When you (or an out-of-band caller holding answers the human
gave in the terminal) only need to bank a round's answers and hand the ball back, call
`submit_elicitation_answers({ task_id, answers })` — the terminal twin of the web's answer form.
Identical `answers` shape and identical guards (whole call refused, no partial write), but it is the
PRODUCER: it stamps `answers_submitted_at`, leaves the exchange **active** so a follow-up round can
still be filed, and clears the task's awaiting flag so the watch classifies `answers-landed`. Never
reach for `conclude_elicitation` merely to get terminal answers on the record — concluding is a
decision about the exchange, not a way to save answers.

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
Distinguish the two abandons: **system-abandon** (session death — the flag stays down and gate
re-entry re-surfaces the brief later) vs a **human cancel** (§The discuss trigger — the cancel is
immediate and mechanical: the ball-restore puts the untouched brief straight back in front of the
human, no re-entry needed).

## The discuss trigger (B-461)

The human answers an active brief with **`discuss <remark>`** — pushback that wants a conversation,
not a whole regenerated brief. The agent opens an exchange with this **trigger config** and inherits
everything above:

- **`trigger: 'discuss'`**, **`gate`** = the brief's activity (the gate the brief serves), and
  **`brief_id`** = the ACTIVE brief the discussion attaches to.
- **Web capture:** the browser captures Discuss mechanically as
  `pending_resolution = { command: 'discuss', detail }` on the active brief (the same marker shape as
  a reshape, distinguished by the command). The conductor watch classifies it **`discuss-requested`**.
- **Consume = `start_elicitation` + file round 1.** Opening the exchange and filing the first round
  (seeded by the `detail` remark) IS the consume: **filing round 1 clears the brief's
  `pending_resolution`** (engine amendment #1) in the same logical write, so the marker is never
  re-consumable.

**Brief resolution is SUSPENDED from marker capture until the exchange concludes — on both
surfaces.** The suspension predicate: a pending discuss marker (`pending_resolution.command ===
'discuss'`) OR an active attached exchange (`brief_id` set, status `active`). While it holds, do not
accept/defer/resolve the brief (web or terminal) — offer the two escapes instead.

**The TWO escapes:**

- **Force-quit** — existing semantics (§Force-quit): "best efforts, proceed".
  `conclude_elicitation('force-quit')`, then **redraft with what you have**; force-quit claims stay
  quarantined.
- **Cancel** — "never mind — keep the brief as it was": a human-initiated `conclude('abandoned')`.
  Mechanical on the web; in the terminal it is `conclude_elicitation('abandoned')` + the mechanical
  ball-restore (re-set the task's awaiting flag with the brief's own reason). It **restores the
  untouched brief** — NO redraft, NO claims, no iteration bump.

**Conclude → re-compose once.** On convergence, re-compose the brief **once** (the in-place iterate:
`iteration+1`, claims coupled via `underwriting_brief_id`, present with "What I learned from you") —
the re-compose restores the brief's own awaiting reason, putting the updated brief back in front of
the human.

**Claims hygiene on a cancelled exchange:** claims are minted before conclude, so the mint→conclude
window can race a mechanical cancel. When an engine write returns the typed
`{ noop: true, cause: 'exchange-cancelled' }` no-op, the agent **ARCHIVES the claims it minted that
turn** — they must never promote at the brief's accept.

## The worker-question trigger (B-733)

A worker running inside a conducted run — the top-level `harmony-conduct` session, any gate skill it
delegates to (`harmony-clarify`, `harmony-decompose`, `harmony-design-decide`, `start-work`,
`finish-work`), or a `harmony-build`-delegated subagent — that hits (a) a genuine judgment-call
question it cannot safely decide alone, or (b) a capability denial it correctly declines to route
around, must never write the question to stdout and exit. It files a round instead, reusing this
engine unchanged:

- **`trigger: 'worker-question'`** (a free-text value — no migration, per this file's trigger column),
  **`gate`** = the current `workflow_activity`, one question with **`stakes: 'load-bearing'`** /
  **`kind: 'open'`** (the same load-bearing-must-be-open binding as everywhere else in this engine —
  a worker's own judgment call is never a rubber-stampable validate).
- **The question always carries three things:** what triggered it (judgment-call vs
  capability-denial), enough context to answer without reading a container log, and — for a
  capability denial — the specific tool, the target, and concrete redirect options ("skip the edit
  and report back" vs "reopen this for a build-capable context", etc.).
- **The `harmony-build` hand-off.** `harmony-build`'s subagent has no MCP tool access
  (`Read, Edit, Write, Bash, Glob, Grep` only), so it cannot call `start_elicitation` /
  `file_elicitation_round` itself. It reports upward instead: it stops working and ends its final
  report with the literal fenced marker `WORKER-QUESTION: <judgment-call|capability-denial>` followed
  by the question. The delegating gate skill (`start-work`, which owns the build delegation) parses
  its subagent's final report for this exact literal string and, on a match, files the round on
  `harmony-build`'s behalf — naming `harmony-build` as the source in the round's context line — instead
  of treating the subagent's return as a completed or failed build.
- **Filing the round is a clean pause, not an abandonment.** It sets `awaiting_human_reason:
  'elicitation-round'` exactly like any other round — the same first-class, web-visible pause every
  other trigger in this file produces, and the same clean-pause outcome the daemon's worker-exit
  classifier already recognizes generically off `awaiting_human_input` (B-693's one-shot exit
  contract already lists "an active brief or elicitation exchange" as a clean pause).

**The backstop invariant (voluntary stops only).** Before a session voluntarily ends its turn — chooses
to stop rather than continue — it must leave the ticket in exactly one of: state advanced normally (a
gate accepted/completed), an explicit park with an authored reason, or an open elicitation round. No
other voluntary stop path exists; writing a question to stdout and exiting is never one of the three.
This does **not** cover involuntary termination (a SIGKILL/OOM'd worker, exit 137, no output) — that
worker never chose to stop, and is squarely the daemon's dirty-exit classifier's domain, not this
invariant's.

## Resuming onto a staged pending_resolution you can only partially apply (B-733)

A gate skill that resumes onto its own active brief may find a staged `pending_resolution` (a browser
iterate/accept the human already submitted) that it can only **partially** execute — e.g. a capability
denial blocks one part of a multi-part instruction. Never wholesale-discard an actionable resolution
and never re-ask about a part already applied:

1. **Apply everything you structurally can, first.** Execute every part of the staged instruction
   that does not hit a denial or a genuine judgment call.
2. **Scope the round to ONLY the blocked residue.** File a `worker-question` round (per the trigger
   above) naming exactly the part(s) you could not apply and why — never the parts already done.
3. **File before you recompose — in that order, always.** Call `file_elicitation_round` first; only
   after it returns success, re-call your own `compose_brief` on the same active brief (an in-place
   iterate), which nulls `pending_resolution` as part of its write. This order is a **crash-safety**
   property, not a race-safety one — nothing else touches the row concurrently inside one
   single-threaded gate-skill invocation, so there is no race to guard against. The hazard is the
   process dying **between** the two writes: file-then-recompose means a crash after the round lands
   but before the recompose still leaves the instruction recoverable (the round exists,
   `pending_resolution` is still staged, and a fresh resume can retry the recompose); recompose-then-file
   would, on the identical crash, have already cleared `pending_resolution` with no round yet filed —
   permanently losing the instruction. Do not re-derive this ordering as "there's no race, so it
   doesn't matter" — the hazard is crash timing, and crash timing survives being single-threaded.
