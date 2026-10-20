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
row into `recorded_walk_requests` (§5), and the conductor's drain (`src/daemon/recorded-walk-
drain.ts`) picks it up and runs the identical gate-walk core (`runRecordedWalk`, `src/tools/record-
walk.ts`) in-process.

Three surfaces, ONE implementation:

| Surface | Entry point | Runs `runRecordedWalk` |
|---|---|---|
| CLI | `harmony record <ticket> --summary ... --evidence ...` | directly, in the CLI process |
| MCP | the `record` tool | directly, in the MCP server process |
| Web (B-1063) | writes a `recorded_walk_requests` row | the conductor's drain, `src/daemon/recorded-walk-drain.ts`, polling in-process |

**B-1073: there are now plugin-side writers of this table too — the CONDUCTOR first, a hook as fallback.**
A fast-track ticket's post-merge row is filed by **the conductor itself, with no worker leg**
(`src/daemon/fasttrack-release-recording.ts`, called from the scheduler's `handleHeldConduction`,
under the conduction lease). It intercepts only when ALL hold, each fail-closed (anything unconfirmable
⇒ the ordinary queue-a-worker path, unchanged): the conduction's `run_config.fast_track` is true; the
ticket is at `Built` with the awaiting flag down; a `brief_resolved` accept for
`release-decision-pending` is positively evidenced in the activity timeline AFTER the latest advance
into `Built` (the finish-work O1 step 3 rule — never inferred from row shape); no request was already
processed for that accept (a pending/processing one means "already filed", the conductor just holds); and
the recorded `field_values.build_pr` PR is **MERGED** per the injected `SchedulerDeps.getPrMergeState`
(never `runCommand`; the walk's deploy step advances Built→Deployed without checking a merge, and a
bot-authored PR still needs the human's GitHub approval + merge). It then inserts the row
(summary = ticket title, evidence = `build_pr.pr_url`, `requested_by` = the conductor's user id), consumes
the accept remark with `skipRecordedWalkFiling` (so exactly one row exists), rolls the baseline, and
queues no leg; the same loop's drain lands deploy and composes the verify brief.
The fallback is `src/tools/briefs.ts`'s `consumeAcceptRemark` →
`src/tools/fasttrack-release-remark.ts`'s `fileFastTrackReleaseRemarkRecordedWalkIfEligible`, which still
files when a *worker* consumes a release-accept remark (the conductor declined). Both are plain `INSERT`s,
same table, same RLS as the web's own write; neither changes the schema in §5 below.

**Attestation rule (both writers, `remarkAttestsWalk`).** The accept remark is the walk's `attest_walk`
VERBATIM unless it is blank or says the walk was not done (`not walked`, `unwalked`, `haven't walked`,
`not yet walked`, `attest at verify`, `attest later`, `will walk`, `to be walked`, `no walk`, …; the
single list is `UNWALKED_REMARK_PATTERNS`) — then `attest_walk` is **null** and the human attests at the
verify gate. Ambiguity resolves toward "none": wrongly dropping a real attestation costs one re-attest;
the reverse fabricates one.

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
  from_gate?: RecordWalkGateName;       // B-1073 — resume starting at this gate; see the paragraph below
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

**`from_gate` (B-1073) — the walk does NOT always start at clarify.** `RecordWalkArgs.from_gate`
resumes the walk at any gate in its fixed order (`clarify → decompose → design → plan → build →
release → deploy → verify`), skipping every gate before it — omitted, it defaults to `'clarify'`
(every gate runs, unchanged from this contract's original shape). The concrete case this exists
for: a **fast-track ticket's post-merge `recorded_walk_requests` drain** (§5) reads the ticket's
CURRENT `workflow_state` and derives `from_gate` from it (`Built` ⇒ `'deploy'`, since a fast-track
ticket's own build leg already walked clarify→build and composed a real release brief) — landing
only the `deploy` advance and the verify brief, with no re-walk of the gates that already landed.
Every other `workflow_state` the drain handles derives the equivalent gate the same way, defaulting
to `'clarify'` for a ticket still at `Captured`/`Proposed` — today's unchanged behavior for every
non-fast-track walk.

---

## 3. The `EligibilityVerdict` shape — the five items, three tiers

`src/tools/record-eligibility.ts`'s `evaluateEligibility` returns:

```ts
type EligibilityVerdict = 'pass' | 'fail' | 'unattested' | 'deferred';

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

**Amendment (B-1073) — item (e) is `deferred`, not evaluated, for a `to_gate`-bounded walk at or before
`build`.** A walk with `to_gate` in clarify/decompose/design/plan/build never lands release/deploy/verify,
so the verify-walk attestation belongs to gates it does not land (the human attests after the merge).
`runRecordedWalk` then reports item (e) as `DEFERRED` (unless an attestation was supplied, which still
reads `pass`), and `eligible` is computed over the non-deferred items — the other four must pass. A
deferred item is never a blocker. A walk with no `to_gate`, or `release` or later, still refuses on an
unattested (e); `record --check`, `fasttrack check`, and the conductor drain (which never pass `to_gate`)
never produce `deferred`.

**Amendment (B-1073, daemon-files-recording round) — item (e) is ALSO `deferred` for a resumed walk
(`from_gate` past `clarify`).** The attestation is only ever *recorded* by the clarify section, which a
resumed walk skips, and the drain's post-merge walk (`from_gate: 'deploy'`) composes the verify brief but
never accepts it — so with no attestation it defers (e) instead of refusing (an `attest_walk` supplied to a
resumed walk still reads `pass`, and is recorded as a `RECORDED-WALK-ATTESTATION` comment because the
clarify section was skipped). A FULL walk from `clarify` with no attestation still refuses. Consequently
`recorded_walk_requests.result` rows written by the drain CAN now carry `deferred` for a resumed walk.

**Recorder truthfulness (same round).** The clarify-time acceptance criterion is filed ticked, with the
"verify walk attested by" suffix, only for a walk that runs past `build` AND was given an attestation;
otherwise it is filed unticked with no suffix (the build-gate floor is presence-only —
`task_criteria_floor_status`). A walk bounded at or before `build` also backfills missing keys of
`field_values.build_pr` (best-effort `gh pr view`, never clobbering). The composed verify brief states
whether a verify-walk attestation is on file and, when none is, says plainly that the human attests at
the verify gate.

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

**`ratified_by: 'recorded'` is stamped only by THIS walk's own internal `writeGateSlot` calls** (they
pass `ratified_by: RATIFIED_BY_RECORDED` directly, bypassing the MCP `write_gate_slot` tool a human
would call by hand). The MCP `write_gate_slot` tool itself has **no `ratified_by` parameter at all** —
it always stamps the gate's own name (e.g. `'release'`) as `ratified_by`. So a gate slot written BY
HAND — e.g. a human resuming a stuck recorded ticket by calling `write_gate_slot` directly — will read
the gate name, not `'recorded'`. This is expected, not a bug: a ticket that had to be partially
hand-resumed will legitimately carry a mix of `ratified_by` values, and a future reader should not read
that mix as a defect.

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
  `processing` (claimed by a conductor, mid-walk) → `done` (walk completed — check `error IS NULL`, NOT
  the ticket's own state, to confirm success; see below) or `error` (walk refused OR failed mid-walk;
  `error` names why).
- **No lease/token column.** The conductor claims a row with a single conditional
  `UPDATE ... SET status = 'processing' WHERE id = $1 AND status = 'pending'` and checks whether the
  update actually matched a row — Postgres's own row-level atomicity is the whole claim mechanism. A
  peer conductor racing the same row loses cleanly (0 rows affected) rather than double-processing.
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

**B-1073: a SECOND declared evaluation point exists — the conductor's fast-track pre-build admission
check.** `--check`/`harmony record` evaluate eligibility against the CLI's own arguments plus a `gh`
read of evidence links, as above. The conductor's fast-track leg-gate has a DIFFERENT evaluation point:
before firing a fast-track leg, it evaluates over the TICKET TEXT + its declared repos (there is no
diff yet — the leg has not run), via `admissibleForFastTrack` (`src/tools/record-eligibility.ts`) —
`evaluateEligibility`'s own report re-interpreted so an `unattested` verify-walk item alone does not
block admission (the build leg itself will attest the walk). Both evaluation points share the SAME
five-item core; they differ only in WHAT they evaluate against and WHEN.

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

`src/daemon/recorded-walk-drain.ts` lives under `src/daemon/**`, so it reaches the **live** conductor only
after a `git pull` **and restart** on the conductor host's plugin checkout (which tracks `staging` — see
the workspace `CLAUDE.md`'s propagation table). Merging this ticket does not, by itself, make the web
"Record" action (B-1063) functional in production — both the conductor-host pull/restart AND B-1063's own
migration/UI must also have landed and propagated.
