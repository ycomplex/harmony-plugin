# The recorded-walk contract (B-1062)

**Status:** ratified design, landed with B-1062's implementation. This is the contract **B-1063**
(harmony-web's "Record" action, and its migration for the `recorded_walk_requests` table) builds
against — read this document, not the plugin's source, as the source of truth for the table's shape;
`src/daemon/recorded-walk-drain.ts` is written to match it exactly and will need updating (never
silently reinterpreting) if this document's shape ever changes.

**Audience:** whoever builds B-1063 (the web "Record" action + its migration), and any future reader
of `src/tools/record-walk.ts`, `src/tools/record-eligibility.ts`, `src/daemon/recorded-walk-drain.ts`,
or the `harmony record` CLI/MCP surface.

---

## 1. What this is

`harmony record <ticket>` (CLI: `src/cli/commands/record.ts`; MCP: the `record` tool,
`src/tools/index.ts`) walks a non-conducted ticket's gates — **clarify → decompose → design → plan →
build → release** — from a human-supplied summary + evidence links, with **ZERO worker legs**. It
produces the same gate-slot/knowledge-entry trail a conducted ticket would get, marked **"recorded,
not conducted"** by two load-bearing markers (§4). B-1063's web "Record" action is a SECOND entry point
into the exact same mechanism: instead of a human running the CLI/MCP tool directly, the web writes a
row into `recorded_walk_requests` (§5), and the conductor daemon's drain (`src/daemon/recorded-walk-
drain.ts`) picks it up and runs the identical gate-walk core (`runRecordedWalk`, `src/tools/record-
walk.ts`) in-process.

Three surfaces, ONE implementation:

| Surface | Entry point | Runs `runRecordedWalk` |
|---|---|---|
| CLI | `harmony record <ticket> --summary ... --evidence ...` | directly, in the CLI process |
| MCP | the `record` tool | directly, in the MCP server process |
| Web (B-1063) | writes a `recorded_walk_requests` row | the daemon's drain, `src/daemon/recorded-walk-drain.ts`, polling in-process |

---

## 2. The `RecordWalkArgs` / `RecordWalkResult` shapes

Both types live in `src/tools/record-walk.ts` and are the plugin's own in-process contract; they are
restated here because B-1063's request/response mapping (§5) must agree with them field-for-field.

```ts
interface RecordWalkArgs {
  task_id: string;
  summary: string;                      // a one-sentence-statable account of the change
  evidence: EligibilityEvidenceLink[];  // see §3 — evidence links, each optionally pre-annotated
  attest_walk?: string;                 // "<who/what was walked>" — see §3 item (e)
}

interface EligibilityEvidenceLink {
  url: string;
  repo?: string;     // "owner/repo", when already known
  paths?: string[];  // changed file paths this evidence touches, when already known
}

interface RecordWalkGateResult {
  gate: 'clarify' | 'decompose' | 'design' | 'plan' | 'build' | 'release';
  reason?: string;   // the compose_brief `reason` this gate used (absent for 'build' — no brief)
  landed: boolean;
  detail?: string;
}

interface RecordWalkResult {
  task_id: string;
  eligibility: EligibilityReport;       // §3 — always populated, even on a refusal
  refused: boolean;                     // true ⇒ the walk never started; the ticket is byte-identical
  refusal_reason?: string;              // present iff refused
  gates: RecordWalkGateResult[];        // every gate that LANDED, in order, even on a mid-walk failure
  attestation_recorded: boolean;
  error?: string;                       // present on a genuine mid-walk failure (never on a refusal)
}
```

**Refuse-before-write.** `refused: true` means `evaluateEligibility` (§3) found at least one
failing/unattested item and the walk stopped **before resolving a task id or touching the database at
all** — the ticket is provably byte-identical to before the call. `gates` is always `[]` in this case.

**Mid-walk failure.** A thrown error partway through (a compose/resolve/consume call failing) is caught
and reported as `error`, with `gates` naming exactly which gates already landed — never a silent
half-apply. A human (or a re-run of `harmony record`, or `harmony conduct`) resumes from the next
unlanded gate.

---

## 3. The `EligibilityVerdict` shape — the five items, three tiers

`src/tools/record-eligibility.ts`'s `evaluateEligibility` returns:

```ts
type EligibilityVerdict = 'pass' | 'fail' | 'unattested';

interface EligibilityItemResult {
  item: 'multi_repo' | 'migration' | 'risk_class' | 'single_sentence_change' | 'verify_walk_attestation';
  label: string;      // human label, e.g. "Single repo"
  verdict: EligibilityVerdict;
  value: string;       // the value this verdict was READ FROM, e.g. "repos: 1 (harmony-plugin)"
  detail?: string;     // present on 'fail' — why, beyond what `value` already states
}

interface EligibilityReport {
  items: EligibilityItemResult[];   // always exactly five, in this fixed order
  eligible: boolean;                // true iff EVERY item is 'pass'
}
```

The five items, in order:

| # | `item` | Fails when | Can be `unattested`? |
|---|---|---|---|
| a | `multi_repo` | evidence links span more than one repo | no |
| b | `migration` | evidence touches a DB migration path (`PATH_GLOB_TABLE['data-migration']`, `src/tools/risk-class.ts`) | no |
| c | `risk_class` | `detectRiskClasses` over the summary text + evidence paths returns `auth`, `shared-core`, or `irreversible-destructive` (deliberately NOT `data-migration` — item (b) already covers that, on evidence paths alone) | no |
| d | `single_sentence_change` | the summary is not readable as one sentence (>50 words, or more than one sentence-terminator run) | no |
| e | `verify_walk_attestation` | never fails | **yes — the ONLY item that can be `unattested`, and it is NEVER auto-passed.** Requires an explicit `attest_walk` value (CLI: `--attest-walk "<who/what was walked>"`). Absent/blank ⇒ `unattested`. |

`eligible` is false if **any** item is `fail` **or** `unattested` — both block the walk; they differ
only in how `--check` reports them (§6).

---

## 4. The "recorded, not conducted" markers

Every write `runRecordedWalk` makes carries two markers, stamped by the gate-walk core itself — never
the ordinary gate-name/human markers a live conduct run would leave:

1. **`ratified_by: 'recorded'`** on every gate slot (`tasks.field_values.gate_slots.<gate>.ratified_by`
   — `src/tools/gate-slots.ts`'s `WriteGateSlotArgs.ratified_by` override, defaulting to the gate's own
   name for every other caller). Landed on the `clarify` and `release` slots (the only two this walk
   writes directly — see §7's gate table).
2. **`agent-on-behalf:human-recorded`** (`src/tools/provenance.ts`'s widened B-1021 fence — the third
   closed `agent-on-behalf:` suffix, alongside `human-in-session` and `human-in-browser`) on every
   KNOWLEDGE write this core makes.

`resolve_brief`'s own accept `provenance` parameter is a **separate, narrower** closed vocabulary
(`validateResolutionProvenance`, `src/tools/briefs.ts` — `human-in-session` / `agent-synthesized[:mode]`
only, not widened by this ticket). Every accept this core issues uses `agent-synthesized:recorded`.

**The verify-walk attestation (item e, when supplied) lands in TWO places — never only the CLI flag:**

- a **dated ticket comment**, prefixed `RECORDED-WALK-ATTESTATION`, naming who/what was walked, when,
  the summary, and the evidence links; and
- the **`attestation` key inside the recorded clarify gate slot's JSON content**
  (`tasks.field_values.gate_slots.clarify.content.attestation = { what_was_walked, when, evidence }`)
  — readable from the ticket's own face, not just its activity log.

---

## 5. The `recorded_walk_requests` table (B-1063 builds this — the AGREED schema)

```sql
create table recorded_walk_requests (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references tasks(id),
  summary        text not null,
  evidence_links jsonb not null default '[]'::jsonb,  -- EligibilityEvidenceLink[] — see §2
  attest_walk    text,                                 -- null ⇒ unattested (§3 item e)
  requested_by   uuid not null,                         -- the human who filed the record request
  requested_at   timestamptz not null default now(),
  status         text not null default 'pending'
                   check (status in ('pending', 'processing', 'done', 'error')),
  processed_at   timestamptz,
  error          text,
  result         jsonb                                 -- see column notes below
);
```

**Column notes:**

- **`evidence_links`** is a JSON array of `{ url, repo?, paths? }` objects — exactly
  `EligibilityEvidenceLink[]` (§2/§3). `repo`/`paths` are optional; the drain re-derives them via `gh`
  when absent, exactly like the CLI does (see `src/tools/record-eligibility.ts`'s
  `gatherEvidenceSignals`). B-1063's web form may leave both unset and pass bare URLs.
- **`attest_walk`** is nullable text, never a boolean — the attestation's VALUE (who/what was walked)
  is itself the evidence; there is no separate "attested: true/false" flag to keep in sync with it.
- **`status`** is the whole state machine, four values: `pending` (filed, not yet claimed) →
  `processing` (claimed by a daemon, mid-walk) → `done` (walk completed — check `error IS NULL`, NOT
  the ticket's own state, to confirm success; see below) or `error` (walk refused OR failed mid-walk;
  `error` names why).
- **No lease/token column.** The daemon claims a row with a single conditional
  `UPDATE ... SET status = 'processing' WHERE id = $1 AND status = 'pending'` and checks whether the
  update actually matched a row — Postgres's own row-level atomicity is the whole claim mechanism. A
  peer daemon racing the same row loses cleanly (0 rows affected) rather than double-processing.
- **`result`** is nullable jsonb holding the drain's full `RecordWalkResult` (eligibility report,
  gates landed, the `refused` flag) — written on EVERY terminal status (`done` or `error`), null only
  if the walk threw before producing a result at all. This is what lets a web consumer render the five
  eligibility verdicts (`result.eligibility.items`, each `{item, label, verdict, value, detail?}` per
  §3) instead of parsing `error`'s prose.
- **`done` always means the walk ran to completion** — it landed some or all six gates, with
  `error IS NULL`. A refusal (ineligible — the ticket left byte-identical) never lands on `done`; the
  code sets `status = 'error'` for a refusal exactly like it does for a thrown mid-walk exception (see
  `recorded-walk-drain.ts`'s write-back: `if (result.refused) failureMessage = result.refusal_reason`
  unconditionally routes to `finalStatus = 'error'`).
- **`error` status covers BOTH a refusal and a mid-walk exception.** Distinguishing the two: with the
  `result` column above present, `result.refused` (boolean) is the PRIMARY signal — read it directly,
  no string-prefix parsing needed. As a fallback (e.g. `result` is null because the walk threw before
  producing one), a refusal's `error` message still always begins with the literal prefix
  `"harmony record refuses —"` (see `describeIneligibility`, `src/tools/record-walk.ts`) — anything
  else on an `error` row is a mid-walk failure.

**RLS / who may write:** left to B-1063's own migration — this contract fixes only the column shape and
semantics above, not the row-level security policy.

---

## 6. `harmony record --check` — read-only, mutates nothing

`--check` runs `evaluateEligibility` (best-effort `gh`-derived evidence signals, degrading to url-only
evidence if `gh` is unavailable) and prints one line per item:

```
harmony record --check B-2000: Single repo — PASS (repos: 1 (ycomplex/harmony-plugin))
harmony record --check B-2000: No migration — PASS (migration paths: 0 (none))
harmony record --check B-2000: No auth/shared-core/irreversible-destructive risk — PASS (risk_classes: [])
harmony record --check B-2000: Single-sentence-statable change — PASS (summary: 9 words, "Fix the flaky retry timer in the poller.")
harmony record --check B-2000: Verify walk (5+ min) attested — UNATTESTED (verify-walk: UNATTESTED (no --attest-walk given))
```

Exits `0` iff every item is `pass`, else `1`. **Mutates nothing** — no task id is even resolved against
the board (eligibility is evaluated purely from the CLI's own arguments plus a `gh` read of the
evidence links).

---

## 7. Which gates write what

| Gate | `compose_brief` reason | `pending_activity` | Payload-carrying (needs `consume_pending_acceptance_event`)? | Writes a gate slot directly? |
|---|---|---|---|---|
| clarify | `clarification-draft` | `clarifying` | yes | yes (`clarify`, + attestation, §4) |
| decompose | `decomposition-proposal` | `decomposing` | yes | no |
| design | `design-decision-draft` | `designing` | yes | no |
| plan | `plan-draft` | `planning` | yes | no |
| build | *(no brief)* | — (`advance_workflow('building')` directly) | n/a | no |
| release | `release-decision-pending` | `null` | no (`resolve_brief` mints no event for this reason) | yes (`release`) |

This walk always takes the **minimal, mechanical shape**: decompose composes a "no split" frame
(`elements: []`), design composes all three tracks `not-required`, and no placeholder knowledge
decision is minted for either (`decision_ref` omitted on both). A ticket whose true history needs a
richer shape (a genuine split, or a design decision to promote) is exactly what the eligibility floor
(§3) — plus a human's own judgment before filing a `harmony record` request at all — is meant to keep
out of this path; such a ticket should be walked live via `harmony conduct` instead.

---

## 8. Propagation note

`src/daemon/recorded-walk-drain.ts` lives under `src/daemon/**`, so it reaches the **live** daemon only
after a `git pull` **and restart** on the daemon host's plugin checkout (which tracks `staging` — see
the workspace `CLAUDE.md`'s propagation table). Merging this ticket does not, by itself, make the web
"Record" action (B-1063) functional in production — both the daemon-host pull/restart AND B-1063's own
migration/UI must also have landed and propagated.
