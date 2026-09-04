---
name: finish-work
description: Use when the user wants to finish, complete, wrap up, land, or merge their current work. Triggers on phrases like "finish", "done", "wrap up", "land this", "merge", "ship it", or "we're done". In manual-mode projects this is the exit point for development work — it handles the full merge-and-cleanup sequence, exactly as before. In opinionated-mode projects, /harmony-conduct is the entry point that drives the whole lifecycle; this skill implements the release (merge + deploy) and verify gates the conductor delegates to, and your explicit invocation ("finish work" / "land it" / "merge it") is how the release gate is crossed.
allowed-tools: mcp__harmony__* Read Grep Glob Bash Bash(gh *)
disallowed-tools: mcp__harmony__supersede_decision
<!-- record_decision + update_knowledge_entry are permitted (B-836): O2's convention-entry writer needs both; supersede_decision stays disallowed because a convention-entry amend is always an in-place update_knowledge_entry, never a supersede, mirroring record_decision's own tool description (prefer update_knowledge_entry + a dated banner for in-part repairs). -->
---

# Finish Work

Safely land completed work: verify readiness, rebase, squash merge, update main, and clean up the worktree and branch.

## 0. Check project mode

Call `mcp__harmony__get_project`. If `mode !== 'opinionated'`, follow **Manual mode** (the original
merge-and-cleanup flow below — unchanged). If `mode === 'opinionated'`, follow **Opinionated mode**
(it wraps the same merge sequence with the release/verify gates).

---

## Opinionated mode (deploying + verifying)

In opinionated mode the usual entry point is `/harmony-plugin:harmony-conduct`, which drives the whole gate sequence and delegates the release/verify gates to this section; invoking finish-work directly (the explicit "finish work" / "land it" / "merge it" verb) runs just these gates.

The ticket should be at **Built** with `awaiting_human_reason = 'release-decision-pending'` (set by
`/harmony-plugin:start-work`). This path drives `deploying` (Built → Deployed) and `verifying`
(Deployed → Verified). It does NOT rewrite design knowledge (release role).

### O0. PR-less umbrella? (a decomposed parent whose work shipped in its children — B-471)

**Check this BEFORE the release pre-flight.** A decomposed parent (an "umbrella") has NO branch/PR of its
own — its real work shipped in its children's PRs. The DB trigger auto-advances such a parent
**Decomposed → Deployed** once all active children reach **Verified**, and surfaces verify by setting on
the parent row `awaiting_human_input = true`, `awaiting_human_reason = 'verification-ack-pending'`,
`awaiting_human_ref = {"kind":"umbrella-auto-verify"}` — **but it does NOT compose a brief** (so
`get_brief` returns null for the umbrella until this skill composes one).

**The umbrella's `task_id` is the ticket id passed to this skill** — an umbrella has no worktree of its
own and therefore no `.harmony-task.json`; the cwd may even hold a *different* ticket's `.harmony-task.json`,
so do **NOT** read `task_id` from that file for an umbrella. Use the ticket id you were invoked with.

**Detect an umbrella (the authoritative marker is the primary key):**

1. **Primary — the purpose-built marker.** `mcp__harmony__get_task({ task_id })` and check
   `awaiting_human_ref.kind === 'umbrella-auto-verify'`. The harmony-web Phase-1 trigger sets this on an
   auto-advanced umbrella parent, alongside `workflow_state = 'Deployed'`,
   `awaiting_human_input = true`, and `awaiting_human_reason = 'verification-ack-pending'`. Equivalently:
   `workflow_state = 'Deployed'` + `awaiting_human_reason = 'verification-ack-pending'` + it has children.
   This `awaiting_human_ref.kind` marker is the authoritative, purpose-built signal — prefer it over any
   proxy.
2. **Corroboration only — has children, no open PR.** `mcp__harmony__list_subtasks({ task_id })` shows it
   **has children**, and there is **no open PR for its branch** (`.harmony-task.json` has no `branch`, or
   `gh pr view` fails). Treat these as confirmation, **not** as the primary signal: an umbrella has no
   worktree of its own, so `gh pr view` runs against whatever arbitrary branch the cwd happens to be on and
   is unreliable on its own.

Such an umbrella is already at `workflow_state` **Deployed** (auto-advanced) with
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
  trigger set the flag but composed no brief), compose it. Author the brief per
  `skills/harmony-shared/brief-authoring.md` §Verify — the question, must-haves, and engagement it owes
  the human, plus the legibility contract. Consult it; do not restate it. **Also render the B-560 evidence-status line**
  (call `mcp__harmony__get_build_evidence_status({ task_id })` first, prepend it to the brief — for an
  umbrella it renders `Evidence: N/A (umbrella — carried by children)`, the explicit AC4 exemption):

  ```
  mcp__harmony__compose_brief({
    task_id, reason: "verification-ack-pending", pending_activity: "verifying",
    doc: { decide: "Does the umbrella work end-to-end across its children?",
      // B-876 verify frame — an umbrella carries no criteria of its own, so say so with `exempt_reason`
      // rather than rendering an empty ledger (an empty list reads as "nothing to verify", a false claim).
      frame: { kind: "verify", environment: "staging", criteria: [],
               exempt_reason: "umbrella — the work was verified in its children",
               evidence_status: "Evidence: N/A (umbrella — carried by children)" },
      items: [
        { kind: "decision", text: "Acknowledge the umbrella works end-to-end across its children", recommendation: "verify once confirmed" }
      ] }
  })
  ```

- **Resolve on human ack:** show the brief; on the human's **accept** →
  `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })` advances
  **Deployed → Verified** (terminal-positive). **No git.** Report completion and stop — do not fall through
  to O1/O2/O3.

(If `awaiting_human_ref.kind` is not `'umbrella-auto-verify'` — e.g. the ticket has NO children, or it has
its own open PR/branch — it is a normal ticket: skip this section and continue to O1.)

### O1. Confirm the release decision (accept clears the gate — it does NOT release yet)

**Resume-vs-draft check (run this FIRST, before anything else — B-714, closes the release-gate loop).**
Every entry to O1 is one of two shapes: a **fresh** Built ticket that needs its release brief drafted, or a
**re-entry** where the human already accepted the release out-of-band (the browser, or a daemon worker
re-firing on the flag flip) and the accept just hasn't been *executed* yet. `resolve_brief({ command:
"accept", … })` on a `pending_activity: null` brief only clears `awaiting_human_input` — it does NOT move
`workflow_state` off `Built` (Built→Deployed is a SYSTEM transition triggered by the deploy actually
succeeding, not by the accept). Conflating the two is what loops: drafting ANOTHER
`release-decision-pending` brief on top of one that was already accepted (B-265, B-713). Telling them apart
is the whole job of this check — and since B-734 it is decided by **recorded evidence of the accept**, not
by the shape of the ticket row.

1. `mcp__harmony__get_task({ task_id })` and `mcp__harmony__get_brief({ task_id })`.
2. **A brief is active, or the flag is up for `release-decision-pending`** → this is the ordinary release
   gate, not a resume: show the active brief, or draft one if the flag was set before a brief was composed.
   Continue below.
3. **Otherwise — no active brief, and no `release-decision-pending` flag. Detect a prior accept by POSITIVE
   EVIDENCE (B-734), never by absence.** The evidence is the **`brief_resolved` activity entry for the
   release brief**, written by whichever surface resolved it (web or session). Call
   `mcp__harmony__list_activity({ task_id })` and, over that chronological timeline, take:
   - the LAST `type: 'event'` with `event_type === 'field_change'`, `field_name === 'workflow_state'` and
     `new_value === 'Built'` — the start of THIS release cycle; then
   - any **later** `type: 'event'` with `event_type === 'brief_resolved'`,
     `metadata.reason === 'release-decision-pending'` and `metadata.command === 'accept'`.

   **That entry is the accept.** Found → the release decision was genuinely made (`metadata.provenance`
   names who made it — `human-in-browser` from the web, `human-in-session` from a session): **skip
   drafting/composing another brief entirely and go straight to O2** to execute the merge + deploy.
   Requiring the entry to sit AFTER the latest advance into `Built` is what stops a re-opened ticket
   (`revising-building` → re-built) from resuming on its *previous* cycle's accept.
4. **No such entry → FAIL CLOSED. Absence of the entry is NOT an accept — never merge on it.** Do not fall
   back to the row shape, and do not end the run quietly. B-745 retired the bespoke pause tool this branch
   used to call — a stranded pause with no web-side clearing mechanism strands the ticket worse than none —
   so instead, RE-FIRE the ordinary release brief, the exact same composition used to draft a fresh
   Built→awaiting-release decision, just re-invoked because the prior acceptance wasn't recorded:

   ```
   mcp__harmony__compose_brief({
     task_id, reason: "release-decision-pending", pending_activity: null,
     changed_paths: [<the PR diff paths — compose derives frame.risk_classes from them>],
     doc: { decide: "Release <ticket> — merge PR <pr_number> and deploy to staging?",
       // The release frame (B-876) — see "The release frame" below for every field.
       frame: { kind: "release",
         act: { repos: ["<repo>"], pr_count: 1, lands_in: "staging", atomicity: "single", irreversible: [] },
         unproven: [], evidence_status: { proven_by_run: 0, walk_at_verify: 0, unproven: 0, total: 0 },
         risk_classes: [] },
       context: [
         "The prior acceptance wasn't recorded — please re-affirm.",
         // The PR reference rides doc.context, never a new typed field — read build_pr defensively.
         "PR: <pr_url> (branch <branch>, head <head_sha>)",
       ],
       items: [{ kind: "decision", text: "Re-affirm shipping the built artefact — PR <pr_url>", recommendation: "release" }] }
   })
   ```

   `pending_activity: null` is load-bearing, not incidental: Built→Deployed is SYSTEM-on-deploy-success,
   never human-accept (state-machine §6.1), so any other `pending_activity` would make the human's accept
   attempt an invalid `workflow_transitions` edge. This is an ORDINARY `release-decision-pending` brief —
   the same shape O1 drafts for a fresh Built ticket in step 2 above — so the human sees an ordinary release
   gate, not a bespoke pause: **accept** clears the flag and resumes straight into O2 (this same
   resume-vs-draft check now finds the fresh `brief_resolved` entry this composition writes on accept), and
   **defer** parks the ticket via `resolve_brief({ command: "defer" })`'s ordinary, existing behavior —
   nothing bespoke is needed for that either. This is also what covers **tickets that predate B-734**: they
   carry no `brief_resolved` entry at all, so they must never be auto-merged on a matching row shape — the
   human re-affirms once, and the entry exists from then on. Declining to merge on absence-of-evidence is
   exactly what the original B-734 fail-closed check did, and it was right — B-745 only changes HOW the
   human is asked, from a dead-end pause to an ordinary, resolvable brief.

   **Loop guard — a `Parked` ticket must never re-enter this check.** If the human **defers** the
   re-composed brief, `workflow_state` becomes `Parked`. `Parked` is a terminal state with no gate
   (`skills/harmony-shared/gate-routing.md` — "Terminal states (`Verified`, `Parked`, `Cancelled`) have no
   gate: they end the lifecycle"), so neither `harmony-conduct` (keyed on `workflow_state`) nor
   `harmony-next` (keyed on `awaiting_human_reason`, which `defer` clears) route a `Parked` ticket back into
   this O1 resume check on a later pickup. A torn evidence-missing pause therefore cannot loop forever
   re-composing briefs: a deferred one simply stops here, at `Parked`, same as any other deferred release
   decision.

**Why positive evidence, and not the row shape (the claim this replaces).** This check used to infer the
accept from `workflow_state === 'Built'` AND `awaiting_human_input === false` AND a null `get_brief`, and
called that shape *unambiguous*. **It is not.** `harmony-conduct`'s *one-shot exit contract* classifies
**exactly** that shape — state advanced, no composed brief — as a **TORN pause = DIRTY** (a crash in the
advance→compose window). Two skills read one row shape as opposite things, and the merge is the
irreversible side of that disagreement: reading a torn pause as an accept converts a crash into a merge
nobody authorised. The row shape now says only that a resume *might* be due; the `brief_resolved` entry is
what authorises one.

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
4. **Pass the same paths into `compose_brief` as `changed_paths` (B-876).** `compose_brief` recomputes
   `frame.risk_classes` from them with the same deterministic detector and **overwrites whatever the doc
   authored** — compose is authoritative for that field, so it cannot drift from the diff and cannot be
   prose-guessed. No `changed_paths` ⇒ an empty list, which is the honest answer for an umbrella with no
   diff of its own.

Prefer this path-derived signal over any prose-derived set — the path signal is high-precision and avoids the
prose false-positives B-516 fixed.

**TWO DIFFERENT SIGNALS REACH THIS BRIEF — and the second one is NOT diff-derived (B-516 / B-876).** Do not
collapse them:

- **`frame.risk_classes`** — path-derived from THIS build's diff, computed by `compose_brief` (above).
- **The classes recorded at gates this run AUTO-ADVANCED** under `--unattended` / the auto-advanced prefix
  of `--pause-at`. Those runs deliberately do not pause mid-flight on a risk class; the conductor records
  the classes instead and this brief is where the human finally sees them (`harmony-conduct` §3a / §4b).
  They are **not** derived from any diff, so the diff-derived field above does not carry them and never
  will. Surface them as their own prose line on the brief, **explicitly labelled as carried from gates**,
  e.g.: *"⚠ Carried from gates auto-advanced this run: **auth** (design), **data-migration** (plan) —
  recorded rather than paused on, per B-516; this is your first look at them."* If the run paused at every
  gate, or no class was ever recorded, show nothing extra.

Dropping that second line because the first one is now typed and mechanical would silently weaken the
unattended-mode floor — the floor exists *because* those runs do not stop mid-flight.

**Override-gate attention block (B-773).** Alongside the risk-class signal above, surface any per-gate
`auto_approve_gates` overrides this run exercised. `mcp__harmony__list_comments({ task_id })` and collect
every `OVERRIDE-GATE-EXECUTED gate=<gate> conduction_id=<id-or-"none">` marker (`harmony-conduct` §4b posts
one per override-provenance auto-advance — see `skills/harmony-shared/gate-routing.md` §Resolution
provenance and `harmony-conduct` §4b's own marker-posting paragraph). **Filter by `conduction_id`** when
THIS run has one (`get_project`'s `environment.conduction_id`, from step 0's call — the common
daemon-driven case): keep only markers whose `conduction_id` matches. **When `conduction_id` is `null`**
(an ad hoc interactive run with no conduction row), include **every** matching marker found on the ticket —
a deliberate best-effort imprecision, acceptable because this is an FYI attention line, not a safety floor
(unlike the risk-class signal above, which IS one). Render the matches as their own attention block on the
release brief, right alongside the risk-class signal, e.g.: *"ℹ Auto-approved gates this run: **clarify**,
**plan** — see their `OVERRIDE-GATE-EXECUTED` comments for what each executed."* If none are found, show
nothing extra.

**Dedup-degradation attention line (B-776).** Same rail, same call: from the SAME
`mcp__harmony__list_comments({ task_id })` result above, also collect every
`DEDUP-DEGRADED routes=<comma-joined route names> codes=<comma-joined SQLSTATEs>
conduction_id=<id-or-"none">` marker (`harmony-clarify` §3c posts one when the dedup retrieval degraded —
see its "Degraded retrieval" block). **Filter by `conduction_id`** when THIS run has one
(`get_project`'s `environment.conduction_id`); when it is `null`, include **every** marker found on the
ticket — the same deliberate best-effort imprecision the override block above states, acceptable for the
same reason (an FYI attention line, not a safety floor). Render the matches as their own attention line,
naming the routes and codes verbatim from the marker, e.g.: *"⚠ Dedup retrieval was degraded at clarify:
**lexical-full** (`57014`), **intent** (`57014`) — the related-tickets check ran on the title alone, so a
duplicate or overlapping ticket may not have surfaced. Worth a manual look before this lands."* If none
are found, show nothing extra.

**This is the UNATTENDED half of the ticket's surfacing requirement.** An attended run sees the
degradation live on the clarify card; an unattended one has nobody watching, so the marker comment is the
only thing that carries it forward — and this line is where a human finally reads it. It rides the
existing B-516 record-and-carry rail exactly: **record at the gate, surface at the release brief**. It
must **NEVER** introduce a pause, a block, or a refusal mid-run — degraded dedup is an FYI, and failing
the run on it would be strictly worse than the silent drop it replaces. A missing marker is not evidence
of anything: say nothing rather than asserting the dedup check was clean.

**Prerequisite-PR attention line (B-783).** When `field_values.prerequisite_pr` is present, show its LIVE
merge status as its own attention line, framed against the environment THIS release actually reaches —
**prod** for a daemon-driven run (the standing `PLUGIN_REF=main` + prod-board posture, workspace
CLAUDE.md → "Sharpest case"), not staging:

1. `gh pr view <prerequisite_pr.pr_number> --repo <prerequisite_pr.repo> --json state,url`.
2. **Not confirmed `MERGED`** (open, closed-unmerged, or the fetch errored) → add an attention line above
   the decision, e.g.: *"⚠ Prerequisite PR `<pr_url>` in `<repo>` is not yet merged (state: `<state>`) —
   this release runs against **prod**, and code depending on the prerequisite may not be safe to run there
   until it lands."* The SAME live check governs O2's refusal below (§"Fail-closed conditional branch for
   `field_values.prerequisite_pr`") — this is where the human first sees it, not a surprise at merge time.
3. **Confirmed `MERGED`** → render it informationally in `doc.context`, e.g. `"Prerequisite: <pr_url>
   (merged)."` — nothing to act on.
4. **The fetch itself errored** → state the error explicitly in the attention line, never silently omit
   it (same discipline as the CI-evidence fetch failure below).

**One `gh pr view` call, three uses: bot-approval + CI evidence + per-PR check status (B-732, B-765 AC4,
B-861).** Before showing the brief, make a single call for the `build_pr` PR, extended with
`statusCheckRollup` so the brief's CI evidence is FETCHED from the PR's checks rather than asserted from
local/partial evidence, and with `headRefOid` so the check-status section below can stamp each entry with
the commit its checks were read for:

```
gh pr view <pr_number> --json author,statusCheckRollup,headRefOid
```

Make this call **once per pull request** the defensive `field_values.build_pr` read below names — the
check-status section renders one entry per PR off exactly that list.

**Bot-approval line.** A daemon-built PR is authored by the `harmony-daemon` App, and GitHub forbids a PR
author approving its own PR — so the merge cannot happen on the human's Harmony accept alone. If
`author.is_bot` is true, add a second attention line alongside the risk signal, naming the PR:

> *"⚠ This PR is authored by `harmony-daemon[bot]` and needs your approval on GitHub before it can merge:
> `<pr_url>`. Accepting here is your go-ahead; the merge runs once the approval lands."*

**CI evidence + earlier-red-run line (B-765 AC4, B-857) — pointer, not a restated copy.** The contract
lives in `skills/harmony-shared/brief-authoring.md` §Release → the CI-evidence must-have: cite the run
id + conclusion (from `statusCheckRollup` above, e.g. *"CI: run <id> — <conclusion>."*), and disclose
any earlier run on this branch that concluded failure before a later commit went green. This read is
informational only, at brief-compose time — time passes between accept and the actual merge, so a FRESH
read at O2 governs the actual merge decision; this line does not itself gate anything.

**The earlier-red-run fetch.** Once per pull request, alongside the call above:

```
gh run list --branch <branch> --json databaseId,conclusion,headSha,createdAt
```

Sorted by `createdAt` ascending. Any entry whose `conclusion` is not `SUCCESS` and whose `createdAt`
precedes the run behind `headRefOid` is an earlier red run — name it, e.g. *"Earlier run <id> failed
(<conclusion>) before this commit went green."* None found → say so plainly, e.g. *"No earlier run on
this branch failed."*

**Capability denial.** If either call 403s (a capability denial — e.g. a repo-scoped `403 Resource not
accessible by integration`), the check surface is unreadable: add a legible attention line to the brief
instead, verbatim in shape — *"⚠ Unable to fetch CI status — <error>. Reviewing without check
confirmation."* Never assert local/partial evidence (a local test/lint/type-check run, a partial `gh`
read) in its place, and never silently omit the line. This is the capability-denial doctrine (stated in
full at O2 below, where it also governs the merge-time CI wait) applied at brief-compose time: a
proceed-worthy read failure, since branch protection independently backs whatever the checks would have
shown.

**The release frame (B-876) — author `doc.frame` on every release brief you compose or re-compose.**
Release is the one gate with a measured wrong accept, and it had no field at all for the act it
authorizes; one author faked one with an ALL-CAPS header inside a `context[]` string. The frame renders
**below DECIDE and above Recommend** — the object of the decision named before an opinion is offered
about it:

```
frame: {
  kind: "release",
  act: {
    repos: ["harmony-plugin"],
    pr_count: 1,
    lands_in: "staging",                  // 'staging' | 'production' | 'both' | 'merged-main'
    atomicity: "single",                  // 'single' | 'together' | 'ordered'
    // ordering: "<REQUIRED when atomicity is 'ordered' — web first, then plugin, ...>",
    irreversible: []                      // [] renders as "nothing — every step is revertable"
  },
  // What will be LIVE BUT UNPROVEN when this lands, closed-enumeration, each with its reason. [] = nothing.
  unproven: [{ item: "<what is unproven>", reason: "<why the build did not prove it>" }],
  // EXECUTED-AWARE counts from get_build_evidence_status + your own knowledge of what actually RAN.
  // An unexecuted test is ZERO evidence, not weak evidence (B-745 shipped an RPC that raised on every call).
  evidence_status: { proven_by_run: 7, walk_at_verify: 2, unproven: 0, total: 9, detail: "<the mechanical line, verbatim>" },
  risk_classes: [],                       // leave empty — compose OVERWRITES this from `changed_paths`
  pr_review_state: "<the PR's reviewDecision, e.g. REVIEW_REQUIRED>"
}
```

`lands_in` is an enum precisely so a release brief can no longer say "to production?" while the act is a
merge to `main` (2/14 briefs misstated the environment). `irreversible` names the specific one-way part —
a `supabase db push` is forward-only and can only be repaired by a second migration — separated from the
parts that are merely git-revertable; a blanket "this is irreversible" is not the same claim.

**The PR reference rides `doc.context`, NOT a typed field (B-876).** Read `field_values.build_pr` and put
a PR line in `doc.context`, e.g. `"PR: <pr_url> (branch <branch>, head <head_sha>, reviewDecision
<reviewDecision>)"`. Do **not** invent a new typed `doc` field for it: the shipped web cards renderer
enumerates the recognized-kind fields by name, so a field it does not know is dropped on the floor with no
error anywhere — the reader simply never sees it, in the view they use by default. `compose_brief` warns
(never refuses) when the task records a pushed PR and the brief names none.

Read `build_pr` **defensively**: its shape is not enforced and three divergent forms exist on the live
board — sibling keys (`build_pr` + `build_pr_plugin`, B-740), nesting (`build_pr.web_pr` /
`build_pr.plugin_pr`, B-743), and a non-PR sibling (`work_branch`, B-844). **Name what you can read and
omit what you cannot**; never fail the compose over an unfamiliar key. (The multi-PR *merge* guard is a
separate thing and still applies at O2 below — naming extra PRs on the brief is not permission to merge
them.)

**The check-status section — one entry per pull request, never omitted (B-861).** Nobody is asked to
authorise a merge blind, so the brief must say what each repository's own checks reported. The contract is
`skills/harmony-shared/brief-authoring.md` §Release → the "What the repository's checks reported"
must-have: four dispositions (**concluded** / **still in flight** / **none reported** / **unreadable**),
each stamped with the commit the checks were read for and the read time, a head mismatch stated in words,
and an attention line above the section for any non-success conclusion. **Do not restate that contract
here — render it.**

Iterate the **same defensive `build_pr` read above**: every PR reference you were able to name there gets
its own entry, in the order you named them, from that PR's own `gh pr view` call. A single-PR release
therefore renders as **exactly one entry** — that is the same code path, not a special case — and a
release naming two PRs renders two, never one merged summary. Omitting the section is never an option:
if there is nothing to report for a PR, the disposition itself says so.

This section is **informational and non-blocking**. It never gates the accept; the human decides with the
checks in view. (The merge-time behaviour is O2's, and a failing check is already the action side's
concern — this gate's job is to make sure the human was told.)

<!-- deployment-specific: begin -->
> **On this deployment, the concrete read is…** — a fact about this deployment, not part of the contract
> above. Resolve the disposition from the **PARSED PAYLOAD** of the `gh pr view <pr_number> --json
> author,statusCheckRollup,headRefOid` call above, **never from a command's exit status**: `gh run watch
> --exit-status` has exited zero here on a run that concluded `failure` (workspace CLAUDE.md → "Deploy
> gotchas"), so an exit status proves nothing.
>
> - `statusCheckRollup` absent, `null`, or not an array — including the `403 Resource not accessible by
>   integration` denial the CI-evidence line above already handles → **unreadable**; name the error.
> - an empty array → **none reported**, scoped to that `headRefOid` and read time (a just-pushed head is
>   not a repository without CI).
> - a non-empty array whose every element carries a terminal conclusion → **concluded**; name each check
>   and its conclusion.
> - a non-empty array with any element still queued or in progress → **still in flight**, while still
>   naming each already-concluded check and its conclusion.
>
> `headRefOid` is the commit the checks were read for — stamp the entry with it and with the time you
> read it. Any element whose conclusion is not `SUCCESS` (`FAILURE`, `TIMED_OUT`, `CANCELLED`,
> `ACTION_REQUIRED`, `STARTUP_FAILURE`, …) triggers the attention line above the section, alongside the
> bot-approval and prerequisite-PR lines.
<!-- deployment-specific: end -->

Say the approval line on the brief rather than only at the merge, so the human can approve while they are
already looking at the release decision instead of being stopped afterwards. On the human's **accept**:

```
mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })   // pending_activity: null → clears the flag, NO state change
```

`provenance: "human-in-session"` is the human's decision, made here (B-734) — and it is the **only** value
this gate can ever carry from the plugin: release is the hard floor, so the conductor never synthesizes it
(`skills/harmony-shared/gate-routing.md` §Resolution provenance). That accept is also what writes the
`brief_resolved` entry a later resume reads at the top of this section.

**Land the release section on the ticket (B-867) — immediately after the accept, NON-OPTIONAL:**

```
mcp__harmony__write_gate_slot({ task_id, gate: "release" })
```

A gate brief is a moment: once it resolves, what release ratified — what shipped, where it landed, the
PRs it landed through, what is live but unproven — survives only inside a brief row nobody reads again.
This lands it on the ticket's own face, permanently. **You author nothing**: the tool reads this gate's
own brief and projects the `doc` the human just ratified, so the section and the brief cannot disagree —
there is deliberately no `content` parameter to fill in. It only needs the release **frame** you already
authored above (`doc.frame.kind: "release"`); a brief without one returns `{ written: false, reason }`
and changes nothing, which is a signal your brief was frameless, not an error to route around.

Call it **after** the accept and **before** the merge (O2): the accept is what ratifies the content, and
`field_values.build_pr` — which the section's PR list is pinned from — is already recorded by then.
Re-running it is safe: it replaces THIS gate's section, touches no other gate's, and never disturbs any
other `field_values` key (`build_pr` / `work_branch` are safe by construction).

Clarify needs no such call — its section rides its own accept payload automatically.

The release brief carries `pending_activity: null` (state-machine §6.1 — Built→Deployed is
SYSTEM-on-deploy-success, not human-accept). So accept is only the human's "go"; the ticket stays **Built**
until the deploy actually succeeds (O2). In a live, synchronous session the accept above falls straight into
O2 in this same invocation — no gap for the loop to occur. A *later* re-entry (the human accepted from the
browser, or a daemon worker resumes on the flag flip after the fact) is exactly what the resume-vs-draft
check at the top of this section catches — it skips redrafting and resumes straight into O2 there instead.
(If the human defers, `resolve_brief({ command: "defer", provenance: "human-in-session" })` parks it — do
not merge.)
**discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
**A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

### O2. Run the merge + deploy, THEN advance to Deployed

**Multi-PR shape guard (B-726 (c/c1)) — run BEFORE any merge, every time.** Read the ticket's
`field_values` in full (not just `build_pr`) and scan every OTHER key for a PR-shaped value (an object
carrying `pr_number` or `pr_url`) — this covers today's observed improvisations `companion_pr` (B-715)
and `build_pr_phase_a_merged` (B-734), and any future ad-hoc key a build invents when it produced more
than one PR. **If any PR-shaped key besides `build_pr` is found, do NOT merge anything — not even
`build_pr`.** Instead:

1. `mcp__harmony__add_comment({ task_id, content: "Release guard: found additional PR-shaped field(s) in field_values beyond build_pr (<key names>) — refusing to merge a subset. This build produced more than one PR; the release path only knows how to land field_values.build_pr safely." })`
2. This is a build-artefact anomaly, not a normal release choice, so open a `worker-question`
   elicitation round rather than the ordinary release brief:
   `mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question' })` then
   `mcp__harmony__file_elicitation_round` naming every PR-shaped key found and asking the human how to
   proceed (e.g. merge in a stated order by hand, or split the remaining work into per-repo children).
3. End the leg. Do not advance `workflow_state`.

This is a pure defensive shape check for the common single-`build_pr` case (unaffected) — it is NOT the
deferred multi-PR merge loop; decompose-per-repo remains the accepted interim for cross-repo work (B-734
showed a deliberately-unsplit cross-repo ticket can still reach this guard, which is exactly why it must
not depend on that interim holding).

**Fail-closed conditional branch for `field_values.prerequisite_pr` (B-783) — checked BEFORE the catch-all
refusal above.** `prerequisite_pr` is a RECOGNIZED PR-shaped key (unlike `companion_pr` /
`build_pr_phase_a_merged`, which remain unconditional worker-question refusals above) — it names a
genuinely cross-repo dependency the build leg could not merge itself. When `field_values.prerequisite_pr`
is present, do NOT fold it into the catch-all "additional PR-shaped key found" refusal above. Instead, run
a LIVE merge-status check before deciding:

```
gh pr view <prerequisite_pr.pr_number> --repo <prerequisite_pr.repo> --json state
```

- **`state === 'MERGED'` (positively confirmed by a successful fetch)** → the dependency is satisfied.
  Proceed with `build_pr`'s merge normally; render the prerequisite informationally on the release brief
  (see O1's prerequisite-PR attention line) rather than blocking.
- **Anything else — `OPEN`, `CLOSED` (unmerged), an errored fetch (network/auth/rate-limit), or the PR
  not found** → FAIL CLOSED: do NOT merge `build_pr` either.
  1. `mcp__harmony__add_comment({ task_id, content: "Release guard: prerequisite PR <prerequisite_pr.pr_url> is not confirmed merged (<state, or the fetch error>) — refusing to merge <build_pr.pr_url> ahead of it." })`
  2. Open a `worker-question` elicitation round (`start_elicitation` + `file_elicitation_round`) naming
     the prerequisite PR, its live (or unreadable) state, and asking the human to confirm before
     proceeding — the same routing the catch-all guard above uses, not a new mechanism.
  3. End the leg. Do not advance `workflow_state`.

  **A fetch error is never treated as equivalent to `MERGED`.** An implementation keyed on
  `state === 'OPEN' ? refuse : proceed` fails OPEN on any fetch error and silently defeats the whole
  guard — exactly the loophole this check exists to close (B-761: a prerequisite PR was still open when
  the dependent PR merged, with no gate having read its live status at all).

**Branch on `field_values.build_pr`** (B-722's recorded pushed-PR reference — shape `{ branch, head_sha,
pr_number, pr_url, base: "main", opened_at }`) to decide how to land the code. This is what makes O2 work
for a daemon-built PR whose worktree is long gone by the time release runs (it was built inside an ephemeral
`--rm` container) — the LOCAL-WORKTREE precondition is no longer a hard requirement, it's just one of three
paths:

- **`build_pr` present (the common case — daemon- or human-built, B-722 recorded it):** merge it via the
  REST endpoint already established for the bypass floor (B-712), directly — **no local worktree required:
  no checkout, no rebase, no force-push.**
  1. **Wait for CI** — run `gh pr checks <pr_number> --watch`, with the exit status EXPLICITLY CAPTURED
     (`$?`) — never pipe it through `tail` or anything else that discards the exit code (a prior version of
     this step did exactly that — `... --watch --interval 15 2>&1 | tail -40` — silently losing `gh`'s exit
     status; B-765). The checks already ran against the pushed head from the build step; there is no
     rebase/force-push here to re-trigger them.

     - **Output is literally `no checks reported on the '<branch>' branch`** → treat this as
       NOT-YET-REGISTERED, never proceed-worthy: the checks simply haven't started reporting yet. Wait a
       short interval and retry, rather than reading the empty result as a pass.
     - **A genuine CI failure** (checks ran; one or more concluded failure) → this is an OBSERVED failure,
       not a denial — do **NOT** merge and do **NOT** infer past it. End the leg; the ticket stays Built.
     - **A capability denial** (e.g. `403 Resource not accessible by integration`, or equivalent — `gh`
       cannot even read the checks) or **success** (checks read clean) → both fall through to step 1c
       below, which resolves a denial via `mergeStateStatus` and, on success, still runs the same combined
       read for the mergeability check next (no duplicated work either way).

  **Capability-denial doctrine (B-765) — scoped narrowly to this release gate's CI/deploy-confirmation
  denial class, NOT a general-purpose classifier:**

  - **Proceed-worthy:** the release gate cannot READ a signal about work that already happened and is
    independently enforced elsewhere — CI checks already ran against the pushed head; branch protection
    independently blocks a non-CLEAN merge; `mergeStateStatus` is GitHub's own computed rollup of those
    same checks. Infer past it, and say so explicitly in the trail comment.
  - **Stop-worthy:** the release gate cannot CONFIRM a fact needed to decide what to do NEXT that no other
    mechanism enforces — e.g. cross-repo deploy ordering (nothing stops merging PR #2 before PR #1's
    migration is live except the worker's own check). Ask a human (`worker-question`).
  - **The distinguishing question — state it explicitly before inferring:** is there an independent
    enforcement mechanism (branch protection, required checks) backing the inference, or is the worker's
    own read the only thing standing between "proceed" and a real ordering/safety violation? The former is
    proceed-worthy; the latter is stop-worthy.
  - `harmony-conduct`'s §4e ("never route around a denial") is UNAFFECTED by this doctrine — it governs
    denials generally; this is the narrow, named exception for the release gate's own CI/deploy-confirmation
    reads, backed by an independent enforcement mechanism. Reference this doctrine from here rather than
    restating it in harmony-conduct.

  1a. **THE IDENTITY + APPROVAL GATE — FAILS CLOSED (B-732).** Daemon PRs are authored by the
     `harmony-daemon` App so the B-695 merge floor actually engages on them. Read both signals in one call:
     `gh pr view <pr_number> --json author,reviewDecision`. Then branch on the **RUN CONTEXT**, never on the
     PR's author alone:

     - **Worker run** (`HARMONY_BUILD_CONTAINER` is set — the image-baked marker, B-694): **ASSERT that
       `author.is_bot` is true.** If it is false, the identity swap FAILED (the mint errored, the env slot
       was unset, or a stale founder `GIT_TOKEN` survived into the run) — **HARD-ERROR and STOP. Never fall
       through to the merge.** A founder-authored PR inside a worker run is by definition a broken identity
       swap: merging it would ride the founder bypass and silently reproduce the exact inertness B-732 fixes.
       Comment the failure on the ticket and stop; do not park-and-continue, and do not "retry as founder".
     - **Interactive founder run** (marker absent): the PR is legitimately founder-authored, the bypass
       applies, and this gate no-ops. Proceed to the merge.

     **Why the run context and not `author.is_bot` alone:** inspecting the artefact cannot distinguish "the
     mechanism engaged and produced this" from "the mechanism never engaged and the fallback produced this".
     Gating on the author flag alone fails OPEN in exactly the failure it is meant to catch. B-695 read green
     for the same reason — its checks ran against an actor that was never in use.

     Then, for a bot-authored PR, **require an approving review before merging**. GitHub forbids a PR author
     approving its own PR, so the required review is one the bot cannot supply — that IS the floor. If
     `reviewDecision` is **not** `APPROVED`, do **NOT** attempt the merge. Instead hand the ball to the human
     (below) and stop this leg.
  1b. **Prompt the human and leave a wake trigger (B-732).** A PR waiting on approval must be something the
     human is TOLD about, not something they discover. Merely stopping would leave the ticket at `Built` with
     `awaiting_human_input: false` — in nobody's queue — and a GitHub approval touches no ticket row, so
     nothing would ever wake the daemon to retry. That is a stall by design. So set the flag with the PR
     attached:

     ```
     mcp__harmony__flag_release_approval_pending({ task_id, pr_number, pr_url, review_decision: reviewDecision })
     mcp__harmony__add_comment({ task_id, content: "Awaiting your approval on <pr_url> before the merge can proceed — the PR is bot-authored, so GitHub requires a review the worker cannot supply." })
     ```

     Pass `review_decision: reviewDecision` **unconditionally, every call** — it is exactly the value
     already fetched a few steps above via `gh pr view <pr_number> --json author,reviewDecision`
     (B-745), so it is never re-fetched here; thread the same variable through whether this is the
     first time the leg hits this gate or a retried one. `flag_release_approval_pending` is a
     stateless writer with no way to tell "is this a repeat flag", so this is never conditioned on that.

     Use `flag_release_approval_pending`, **not** `update_task` — the awaiting flag triple is a
     human-pause assertion, and `update_task` deliberately does not expose it (every writer of that
     triple is the tool whose semantics justify it: `compose_brief` owns the brief pause,
     `file_elicitation_round` owns the question pause, and this owns the release-approval pause). It
     sets the flag, the `release-approval-pending` reason, a PR-naming ref (now carrying the
     `review_decision` snapshot alongside it, B-745), and touches nothing else — in particular it
     never moves `workflow_state`, because the ticket legitimately stays at `Built` until the deploy
     succeeds. It is idempotent, so a retried leg re-flags safely.

     The ticket now appears in the human's queue with the PR linked, and their resolution produces the
     `true → false` flag flip the daemon already wakes on. Under `--one-shot` this is a clean human pause:
     **exit here**. In an interactive session, surface the PR URL and wait. Either way, when the run resumes
     the O1 resume-vs-draft check routes straight back into O2 and retries the merge — no redraft, no new
     brief. (This is a *modeled* pause with a first-class reason, which is why it does not go through B-733's
     ad-hoc-question channel.)
  1c. **The combined pre-merge read (B-762 mergeability + B-765 CI-denial resolution) — FAILS CLOSED on a
     genuine conflict, run immediately before the squash-merge, every time.** This is the SAME read B-762
     already needed here, now extended with `statusCheckRollup` so a CI-wait capability denial (step 1
     above) can resolve through it too, and so the trail comment / brief-evidence symmetry (B-765 AC4) has
     the check data available either way — no duplicated work, just one extra field. `mergeable` is
     three-valued (`MERGEABLE` / `CONFLICTING` / `UNKNOWN`) and GitHub computes it **asynchronously** — it
     reads `UNKNOWN` for a window right after a push or base move, which is exactly the moment this check
     runs (immediately after the final push that landed the checks above). Read all three fields in one
     call:

     ```
     gh pr view <pr_number> --json mergeable,mergeStateStatus,statusCheckRollup,headRefOid
     ```

     **`headRefOid`: state a divergence from the head the brief named IN WORDS (B-861).** This is the one
     place a divergence is actually observable — the release brief's check-status section was stamped with
     the commit its checks were read for, and time passes between the human's accept and this merge. If
     `headRefOid` here differs from the head that section named for this PR, the checks the human approved
     against were read for an **earlier commit**. Say that in prose — never leave two commit ids side by
     side for the human to diff — in the release trail comment (step 2 below) and in any `worker-question`
     round filed from this step, e.g.: *"the checks shown on the release brief were read for an earlier
     commit; this pull request has since moved to a new head, so those results do not describe what is
     being merged."* This is a **statement, not a new block**: the `mergeable` / `mergeStateStatus`
     branches below are unchanged and remain the only thing that stops a merge here.

     **If step 1 above hit a capability denial reading CI** (never a genuine CI failure — that already
     ended the leg), resolve it here via `mergeStateStatus`, per the capability-denial doctrine above:
     - **`CLEAN`** → proceed with the merge below. CI already ran against the pushed head, and
       `mergeStateStatus` is GitHub's own computed rollup of those same checks, independently backed by
       branch protection — a proceed-worthy inference per the doctrine above. The release trail comment
       (step 2 below) MUST state the completion was **inferred, never confirmed green**.
     - **Anything else** (not `CLEAN` — including `UNKNOWN`, `DIRTY`, `BLOCKED`, `UNSTABLE`) → do **NOT**
       infer. File a `worker-question` elicitation round — `mcp__harmony__start_elicitation({ task_id,
       trigger: 'worker-question' })` then `mcp__harmony__file_elicitation_round(...)` naming the PR, the
       CI-read failure, and the current `mergeStateStatus` value — and **end the leg**; do not attempt the
       merge.

     **Otherwise** (step 1 read CI cleanly — success, no denial) — continue directly into the `mergeable`
     branches below, UNCHANGED, just with `statusCheckRollup` now also available:

     - **`UNKNOWN`** → re-poll at a few-second interval, **bounded at ~60s total**, until it resolves.
       - Resolves within the bound → fall through to the `MERGEABLE`/`CONFLICTING` branches below.
       - **Still `UNKNOWN` at the ~60s bound** → never guess in either direction. File a `worker-question`
         round: `mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question' })` then
         `mcp__harmony__file_elicitation_round(...)` naming the PR, the current `mergeable`/
         `mergeStateStatus` values, and how long it polled. **End the leg** — do not attempt the merge.
     - **`MERGEABLE`** (clean, or `BEHIND`) → the merge proceeds exactly as today; continue to step 2 below.
       (The non-conflicting `BEHIND` case — recovering via `update-branch` — is explicitly out of scope for
       this ticket; it is documented as a separate follow-up, not implemented here.)
     - **`CONFLICTING`** (a genuine merge conflict) → this is a **code change**, so it belongs to the **build
       gate**, never resolved here — regardless of `git`/`Bash` reachability (B-746: disallowed-tools bounds tools, not effects, so a `Bash`-reachable `git merge` is still off-limits at this gate).
       Do **NOT** attempt `git merge`, do **NOT** edit the conflicted file, do **NOT** `git push` from the release gate. Instead:
       1. Call the shared `reopenToGate(task_id, 'build')` procedure (`skills/harmony-shared/gate-routing.md`
          §Reopen to a target gate) — reopens `Built --revising-building--> Planned`.
       2. `mcp__harmony__add_comment({ task_id, content: "Release blocked: PR #<pr_number> (<head_sha>) has a
          merge conflict with main — reopening the build gate to resolve it (B-762)." })`
       3. **STOP this leg — do not advance past this.** The rebuilt ticket naturally re-enters release's
          normal brief-drafting flow later, requiring a fresh human approval against the new head; no extra
          round-trip mechanism is needed.
  2. **Squash-merge** — `gh api -X PUT "repos/{owner}/{repo}/pulls/<pr_number>/merge" -f merge_method=squash`
     (the same REST form as the manual-mode flow below — `gh pr merge`'s GraphQL path still does not honor
     `bypass_pull_request_allowances` under the required-review merge floor, B-695). `gh` resolves
     `{owner}/{repo}` from the git remote of whatever directory the command runs in, not from a specific
     checked-out branch — running it from the project root, or any clone of the repo, is sufficient.

     **If this merge was reached via step 1c's capability-denial/CLEAN-inference path**, land that on the
     trail immediately once the merge succeeds — extending the existing B-560 trail-comment pattern (and the
     matching inferred-completion phrasing used below for the post-merge deploy confirmation) to the
     pre-merge case (B-765). Never phrase an inferred pre-merge CI pass the same as a confirmed one:

     ```
     mcp__harmony__add_comment({ task_id, content: "merged via PR #<number> — CI check confirmation unavailable (<error>), proceeding on mergeStateStatus: CLEAN (inferred, not confirmed green)." })
     ```
  3. **Delete the remote branch** — `gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"` (this
     mirrors the manual flow's local branch-delete step, just done remotely instead of locally since there is
     no local worktree/branch here to delete).
- **`build_pr` absent, but a local worktree with its own open PR for the current branch still exists** (a
  pre-B-722 interactive ticket that hasn't been through the now-mandatory artefact step): fall back to the
  **manual-mode merge sequence below**, unchanged (pre-flight checks → rebase → force-push → wait for CI →
  squash merge → local cleanup).
- **`build_pr` absent, and no PR anywhere** (the true no-diff/already-live case, B-265 — the fix was already
  live, nothing left to merge): there is no merge step to run; proceed straight to the advance below.

**Confirm the post-merge deploy — IN-FOREGROUND, bounded, before advancing (B-774). NON-OPTIONAL whenever a
merge just landed (either path above); skip only for the true no-diff case, which has no merge to confirm.**
Once the squash-merge lands, confirm the post-merge CI/CD deploy run that fires on `main` **in the same
turn, with a bounded poll — never `run_in_background` this wait, and never end the turn while it is
outstanding.** This is exactly the move `--one-shot` already forbids at every other pause (B-693); "I'll
continue automatically" is false the instant the turn ends, in a worker run or an interactive session
alike — there is no run context where backgrounding this wait is safe.

This IS this gate's own instance of the shared **clean-exit contract**
(`skills/harmony-shared/clean-exit-contract.md`) — the release path was its founding specimen: advancing
before the deploy is confirmed is exactly the "real work landed, no state-advancing write should happen
yet" gap the shared doctrine generalizes from. The mechanics below are release-specific (this gate's own
markers and repo artefacts); the doc is the one place the general rule lives.

1. **Resolve the post-merge workflow run** for the merge commit — `gh run list --branch main --commit
   <merge_sha> --limit 1 --json databaseId,status,conclusion,workflowName` (or equivalent).
2. **Block on it in-foreground with a bounded poll** — `gh run watch <run-id> --exit-status`, capped at
   ~20 minutes (comfortably under the worker's ~90-minute one-shot deadline for an ordinary ~10-minute
   deploy; a genuinely hung run should fail loud instead of silently consuming the whole deadline).
3. **Authoritative conclusion check — required, never skip.** Once the poll returns, confirm the outcome
   via `gh run view <run-id> --json conclusion` — never trust the exit status of `gh run watch` (or
   `gh pr checks --watch`) alone as the final word; both have documented false-greens in this workspace
   (`gh run watch` has exited 0 on a run that concluded failure; `gh pr checks --watch` passes on "no
   checks reported").
4. **`conclusion: success`** → proceed to the advance below.
5. **`conclusion: failure` (an observed failure)** → retry once via `gh run rerun <run-id> --failed` (the
   B-539 esm.sh flake class). If it still fails, do **not** advance — end the leg legibly with the failure
   stated in the trail comment; the ticket stays Built. Never route an observed failure into the
   documented-inference fallback below — that fallback is for CI that cannot be read, not for a CI read
   that came back red.
6. **CI read genuinely unavailable** (the B-765 confounder — e.g. a repo-scoped 403 on harmony-web post
   identity-swap) → fall back to the **documented-inference completion path**: advance to Deployed,
   inferring success from the clean merge landing — but the B-560 trail comment below **must say so
   explicitly** (see the inferred variant there). Never silently treat unreadable CI as a confirmed green
   run with no note.

**Only after the deploy actually succeeds** (the merge above landed and the post-merge deploy confirmed
green or was legitimately inferred per step 6, or the no-diff case is confirmed):

```
mcp__harmony__advance_workflow({ task_id, activity: "deploying" })   // Built -> Deployed (now reality matches)
```

**Land the release trail on the ticket (B-560) — NON-OPTIONAL.** Immediately after the deploy
succeeds and the state advances, comment the build→release→deploy trail so the ticket carries it as
durable evidence (gates only advance `workflow_state`; a delegated/worktree build never touches the
ticket, so without this the trail is lost — B-551 hit Verified with zero build trail):

```
mcp__harmony__add_comment({ task_id, content: "Deployed via PR #<number> — squash-merged to main; deploy succeeded (<run-id/url>)." })
```

**When the deploy was inferred rather than confirmed (step 6 above), the trail comment MUST state that
explicitly** — never phrase an inferred deploy the same as a confirmed one:

```
mcp__harmony__add_comment({ task_id, content: "Deployed via PR #<number> — squash-merged to main; deploy confirmation inferred from merge landing, CI read unavailable (see B-765)." })
```

**Author procedural convention entries per changed surface (B-836).** This runs only here, at O2, after
the deploy above has already succeeded — a ticket that never reaches release (parked/cancelled mid-build)
never reaches this step, so it automatically gets no entry; that's not a special case, it's this step
simply never firing. Reuse this run's changed paths from the B-516 risk signal above (`git diff
--name-only origin/main...HEAD` over the PR / the B-722 `build_pr` record) — do not recompute them.

1. **Qualifying-path filter.** A path qualifies if it touches `container/`, `scripts/`, `commands/`, or a
   config schema file. If NONE of the changed paths qualify, write NOTHING — no entry, no comment. This is
   a deliberate no-op, not a floor violation.
2. **Per-path, not per-ticket.** For EACH qualifying path individually (not the combined set), do a
   separate lookup + write below. A ticket touching N qualifying paths writes N entries (or amends N
   existing ones) — never one combined entry for the whole ticket.
3. **Per-path lookup — the identity key.** For each qualifying path `<path>`, look up whether an Accepted
   convention entry already carries the exact single-path tag `surface:<path>`:
   ```
   mcp__harmony__query_knowledge({ type: "convention", tags: ["surface:<path>"], status: "Accepted" })
   ```
   The surface key is always ONE single path per tag, never the combined set of paths a multi-path write
   touches. Worked example: ticket A touches `{x}` — no match found, so A writes a fresh `surface:x`
   entry. Ticket B touches `{x, y}` — B's write for `x` looks up and amends the SAME `surface:x` entry A
   created; B's write for `y` finds no match and creates a fresh `surface:y` entry. A later ticket C
   touches only `{y}` — C's write amends B's `surface:y` entry, leaving `surface:x` untouched.
4. **Fresh entry (no match found):**
   ```
   mcp__harmony__record_decision({
     type: "convention",
     title: "<short descriptive title mentioning the path>",
     content: "<Decision · Why · How-to-apply · Scope — must contain: (1) the literal invocation(s) that
       changed, (2) any new/renamed config field with its type + default + required-or-optional, (3) the
       failure string a misconfiguration on this surface now produces>",
     tags: ["surface:<path>"],
     domain: ["engineering", "operations"],
     status: "Accepted",
     realization: "live",
     source_task_id: task_id,
     source_activity: "finish-work",
   })
   ```
   Pass `status: "Accepted"` explicitly — this is a system-authored record of what just shipped, not a
   proposal awaiting human promotion (the tool's own default of "Asserted" is for gate-authored
   *decisions*, not for a mechanical record of already-live, already-reviewed-via-merge procedure).
5. **Amend (match found):**
   ```
   mcp__harmony__update_knowledge_entry({
     entry_id: <found id>,
     content: "<prepend a newest-first dated section — today's date, this ticket's id, and what changed —
       onto the EXISTING content; never replace or drop the entry's prior history>",
     realization: "live",
   })
   ```
   Never call `supersede_decision` here — an amend is always an in-place `update_knowledge_entry`,
   matching the disallowed-tools note in this skill's frontmatter (B-836): a convention-entry amend
   is categorically an in-place edit, not a retirement.
6. **Coupling.** After either the fresh-entry write or the amend, link the ticket to the entry it
   authored/amended:
   ```
   mcp__harmony__reference_knowledge({ task_id, decision_id: <the entry's id> })
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

**Audit for cross-ticket completion at the release gate (B-643).** Alongside draining the rollup, ask: *did this run's work also complete another **open** ticket?* Seed candidates by scanning the branch's commits for `[B-XXX]` tags other than this ticket (`git log --format='%s%n%b' origin/main..HEAD | grep -oE '\[B-[0-9]+\]'`); `get_task` each. **Surface the candidates + a recommended disposition on the release brief** for the human to confirm at the hard-floor: **completely covered → `subsume_task`** it into this ticket (+ archive); **uncertain → annotate** the covered ticket's description with a `possibly-subsumed-by: <this> — confirm at clarify/design` flag (do not subsume on a guess). See `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished."** (Skip if this run's work covers no other ticket.)

If CI/deploy goes red, **do not advance** — the ticket stays Built; fix and retry. This is what keeps
`Deployed` meaning "deployed" (state-machine §6.1), so `verifying` (O3) checks against a real deploy
rather than a state that ran ahead of reality (the B-60 conflation — review F4).

### O3. Verify (Deployed → Verified)

After deploy, file the verification brief so the human can acknowledge real-world behaviour matches the
design (state-machine §6.1 — verifying is human-ack by default).

**1. Read the ticket's acceptance criteria (B-703) — NOT optional, and nothing substitutes for it.**
Before composing, make the dedicated read, at the point of use:

```
mcp__harmony__list_acceptance_criteria({ task_id })
```

`get_build_evidence_status` (step 3) **cannot** stand in for this. It returns *booleans* — `all_acs_checked`,
`has_test_cases`, `complete` — and never the criteria themselves: it selects only `id, checked` from
`acceptance_criteria`, so the AC **text never enters the session** through it. That was the B-703 defect —
the recipe composed the verify brief from evidence booleans, which made the §Verify **runbook** contract
*unsatisfiable by construction*: the brief could assert "evidence complete" but could not hand the human a
single step to check. Read the criteria, or you are not composing a runbook.

**2. Compose the runbook FROM that read.** Author the brief per `skills/harmony-shared/brief-authoring.md`
§Verify — the single source of truth for the **runbook**'s shape (hand-checkable ACs become do-X →
expect-Y steps; non-hand-checkable ACs are stated honestly and backed by what the agent ran plus a command
the human can run themselves), along with the question, must-haves, engagement, and the legibility
contract. Consult it; do not restate it. Every criterion returned by step 1 is accounted for on the brief —
it becomes a step, or it is named and explained as not hand-checkable.

**When the ticket has no acceptance criteria of its own**, step 1 returns empty — an umbrella whose work sat
in its children, or a `decision-only` ticket that completes on its Accepted decision. Say that plainly on
the brief (*"this ticket carries no acceptance criteria of its own — the work was verified in its
children"* / *"… its deliverable is the Accepted decision"*) and give the human whatever *is* checkable at
this level (an umbrella's integration check; the decision's landed artefact). Never render an empty runbook
list as though criteria existed — an empty list reads as "nothing to verify", a different and false claim.

**3. Evidence-status line on the verify brief (B-560) — ALWAYS PRESENT, mechanical by construction.**
Call `mcp__harmony__get_build_evidence_status({ task_id })` — the canonical
single-source-of-truth definition of whether this conducted ticket carries the build evidence we require
by Verified (test cases + all ACs checked + a PR/merge/deploy comment trail; an umbrella is exempt). Render
its result as a **one-line evidence-status line** — never optional prose — sitting **underneath the runbook
as supporting confidence**, not as the thing being acked (brief-authoring.md §Verify). Frame it
exactly like the B-516 release-brief risk signal: present on every verify brief, computed mechanically, so
a missing piece is surfaced on the brief the human accepts (it does NOT block accept — it informs it):

- `complete && !is_umbrella` → `✓ Evidence: complete (N test cases, M/M ACs checked, comment trail present)`
- `is_umbrella` → `Evidence: N/A (umbrella — carried by children)`
- otherwise → `⚠ Evidence incomplete: <missing joined by ", ">` (e.g. *"⚠ Evidence incomplete: test cases, 2 unchecked acceptance criteria"*)

(If incomplete and the build genuinely had its own work, land the missing evidence first — record the test
cases via `manage_test_cases`, check the ACs via `manage_acceptance_criteria` — then recompute the line.)

**The ONE part of this that is a floor, not a signal (B-747).** Everything above informs the accept without
blocking it. An **empty** criteria set is different in kind: there is nothing for the shipped work to be
judged against, so acking it is a rubber stamp rather than a judgement. **B-738 is the proof** — Verified
with zero criteria, its verify acked against nothing, on a brief that had *displayed* the
`⚠ Evidence incomplete: acceptance criteria (none created)` line and was accepted anyway. Detection was
never the gap; blocking was.

So before composing (and before resolving) the verify brief:

- **`ev.has_acceptance_criteria` true, or `ev.exempt_reason` non-null** → carry on as above.
- **Otherwise → do NOT compose an ackable verify brief and do NOT attempt `verifying`.** Open an
  **elicitation round** asking the human for the criteria, naming what is missing, and end the leg.

This is the same predicate and the same surface the build gate uses (`start-work` O3) — one floor applied
at the two edges where cost turns irreversible, never a second definition. As there, the pre-check exists
so the refusal is answerable: the substrate guard would refuse by RAISING, which reaches a daemon leg as a
dirty exit and an operator page.

**4. The verify frame (B-876) — author `doc.frame` as the criteria LEDGER.** This is the gate whose whole
contract is "confirm reality against these criteria", and the criterion text appeared in **0/14** rendered
briefs — the reader had to trust a bare list of digits. The frame puts every filed criterion on the page,
**verbatim from step 1's `list_acceptance_criteria` read**, one row each, with its disposition and the
runbook step that discharges it:

```
frame: {
  kind: "verify",
  environment: "staging",             // 'staging' | 'production' | 'merged-main' | 'local' — which
                                      // environment this ack actually covers. Three briefs meant three
                                      // different things by "Verified"; this is an enum so it cannot be vague.
  criteria: [
    { ac_id: "<id>", text: "<the criterion VERBATIM as filed>", checked: true,
      disposition: "walk",            // 'walk' | 'blocked' | 'test-proven' | 'not-hand-checkable' | 'carried' | 'unproven'
      step_ref: "1" },                // REQUIRED on a 'walk' — the runbook step the human follows
    { ac_id: "<id>", text: "<...>", checked: false, disposition: "blocked",
      blocked_reason: "<why it cannot be exercised here>" },
    { ac_id: "<id>", text: "<...>", checked: false, disposition: "carried",
      carried_to: "<ticket>", backed_by: "<the tests that do cover it>" }
  ],
  // exempt_reason: "<umbrella — carried by children / decision-only>"  — when the ticket has no ACs of its own
  evidence_status: "<the B-560 line from get_build_evidence_status, verbatim>",
  // bounded_accept: { open_ac_ids: ["<id>"], closes_when: "<what closes them, and where>" }
}
```

The header line the render computes from it — *"N criteria on file · you can confirm M today"* — is the
number the reader previously had to derive by reconciling ten context bullets against one `why` bullet.
Use `carried` (with `carried_to`) for a criterion this ack deliberately closes OUT of the ticket: accepting
closes it permanently, and the human should see that as a row, not infer it from prose.

```
mcp__harmony__compose_brief({
  task_id, reason: "verification-ack-pending", pending_activity: "verifying",
  doc: { decide: "Does production behaviour match the design?",
    frame: { kind: "verify", environment: "staging", criteria: [/* one row per filed criterion, verbatim */],
             evidence_status: "<the B-560 line, verbatim>" },
    items: [{ kind: "decision", text: "Acknowledge verified", recommendation: "verify once confirmed" }] }
})
```

**Re-entry freshness check (B-703) — arriving at a verify gate ALREADY paused with an active brief.** A
verify pause can sit for days, and the criteria can be edited while it sits (the human tightens an AC; a
re-opened clarify adds one). Before surfacing an existing brief, **re-read the criteria** (step 1) and
compare them against the runbook steps in the active brief:

- A criterion **missing** from the runbook, or one whose **wording no longer matches** the step built from
  it → **re-compose in place**: rebuild the runbook per step 2 and call `compose_brief` again. It updates
  the active brief in place and bumps `iteration` (+1) — it does not file a second brief.
- Otherwise → surface the existing brief **unchanged**. Do not churn `iteration` for a no-op.

**Named residual:** a browser acknowledgement submitted with **no session running** cannot re-read anything
— there is no agent to compare against, so it acks whatever the brief last said. This check covers session
re-entry only; it does not close the headless-browser-ack window.

On the human's **accept** →
`mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })` advances
Deployed→Verified (terminal-positive). Verify is the other hard-floor gate, so like release it is only ever
`human-in-session` from the plugin (B-734).
**discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
**A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

**Land the verify result on the ticket — NON-OPTIONAL, both halves.** Immediately after the accept:

```
mcp__harmony__write_gate_slot({ task_id, gate: "verify" })                                    // B-867
mcp__harmony__add_comment({ task_id, content: "Verified — production behaviour matches the design (human-acked <date>)." })   // B-560
```

They are not redundant. The **comment** is the closing leg of the build→release→verify trail, in the
timeline. The **section** (B-867) is the runbook itself, kept on the ticket's face: which environment
this ack covered, every criterion it was judged against and how each was discharged, and the evidence
behind it — the answer to "what did *Verified* actually mean on this ticket?", asked months later, when
the brief that answered it is long gone.

**You author nothing** — the tool reads this gate's own brief and projects the `doc` the human just
ratified, so the section and the runbook they accepted cannot disagree; there is deliberately no
`content` parameter. It needs the verify **frame** from step 4 (`doc.frame.kind: "verify"`); a brief
without one returns `{ written: false, reason }` and changes nothing rather than failing the accept.

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
> `mcp__harmony__advance_workflow({ task_id, activity: "revising-building" })` (Deployed → Built) and
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
gh pr checks <PR-number> --watch; ci_status=$?
```

Capture the exit status explicitly (`$?`) — never pipe this through `tail` or anything else that discards
it (B-765; keep this in sync with opinionated mode's O2 step 1 above). Treat output literally
`no checks reported on the '<branch>' branch` as NOT-YET-REGISTERED — wait a short interval and retry,
never proceed on it. If CI fails (checks ran; one or more concluded failure), stop and investigate — do not
merge a failing build, and do not infer past an observed failure.

If `gh` cannot even read the checks (a capability denial — e.g. `403 Resource not accessible by
integration`), fall through to the mergeability check in step 3.5 below and resolve it there via
`mergeStateStatus` — per the capability-denial doctrine (`## Opinionated mode` → O2 → the capability-denial
doctrine above): `CLEAN` → proceed (documenting the inference, same as O2, if a Harmony ticket exists for
this work); anything else → do NOT infer — stop and report the CI-read failure plus the current
`mergeStateStatus` value to the user (or file a `worker-question` round if running under opinionated mode's
O2 fallback).

### 3.5 Pre-merge mergeability check (B-762, extended for B-765)

Run this immediately before the squash-merge step below, every time — the same check as opinionated
mode's O2 (`## Opinionated mode` → O2 → step 1c above), applied here because this sequence is ALSO the
fallback path O2 itself uses when `field_values.build_pr` is absent but a local worktree with its own open
PR still exists. `mergeable` is three-valued (`MERGEABLE` / `CONFLICTING` / `UNKNOWN`) and GitHub computes
it **asynchronously** — it reads `UNKNOWN` for a window right after the force-push above, which is exactly
the moment this check runs. Read all three fields in one call — extended with `statusCheckRollup` so a
step-3 capability denial can resolve through this same read (no duplicated call):

```bash
gh pr view <PR-number> --json mergeable,mergeStateStatus,statusCheckRollup
```

**If step 3 above hit a capability denial reading CI**, resolve it here via `mergeStateStatus` first:
`CLEAN` → proceed to the mergeable branches below as usual (and note the inference on the trail, matching
O2's trail-comment phrasing, if this run has a ticket to comment on); anything else → do NOT infer — stop
and report the CI-read failure plus the current `mergeStateStatus` value (or file a `worker-question` round
under opinionated mode's O2 fallback). Otherwise (step 3 read CI cleanly), continue directly into the
`mergeable` branches below, UNCHANGED:

- **`UNKNOWN`** → re-poll at a few-second interval, **bounded at ~60s total**, until it resolves.
  - Resolves within the bound → fall through to the branches below.
  - **Still `UNKNOWN` at the ~60s bound** → never guess. If running under opinionated mode's O2 fallback,
    file a `worker-question` round (`mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question' })`
    + `mcp__harmony__file_elicitation_round(...)` naming the PR, the `mergeable`/`mergeStateStatus` values,
    and how long it polled) and end the leg. In true manual mode (no Harmony gate), stop and report the same
    facts to the user instead.
- **`MERGEABLE`** (clean, or `BEHIND`) → proceed to the squash-merge below exactly as today. (The
  non-conflicting `BEHIND` case — recovering via `update-branch` — is out of scope for this ticket; a
  separate follow-up, not implemented here.)
- **`CONFLICTING`** (a genuine merge conflict) → this is a **code change**, so it never gets resolved here
  — regardless of `git`/`Bash` reachability (B-746: disallowed-tools bounds tools, not effects). Do **NOT**
  attempt to resolve the conflict, edit the conflicted file, or force-push a resolution from this step.
  - **Opinionated-mode caller (this sequence reached as O2's fallback):** call the shared
    `reopenToGate(task_id, 'build')` procedure (`skills/harmony-shared/gate-routing.md` §Reopen to a target
    gate) — reopens `Built --revising-building--> Planned` — comment the PR/head SHA + reason on the ticket
    (`mcp__harmony__add_comment`), and **STOP this leg**. The rebuilt ticket naturally re-enters release's
    normal brief-drafting flow later, requiring a fresh human approval against the new head.
  - **True manual-mode caller (no Harmony gate to reopen):** stop and tell the user the PR has a genuine
    merge conflict with main — they resolve it (or re-run `start-work`/rebuild) and re-invoke finish-work.

### 4. Squash merge the PR

Merge via the REST endpoint (gh resolves `{owner}/{repo}` from the current repo):

```bash
gh api -X PUT "repos/{owner}/{repo}/pulls/<PR-number>/merge" -f merge_method=squash
```

Do NOT use `gh pr merge` — its GraphQL path does not evaluate `bypass_pull_request_allowances`, so under the required-review merge floor (B-695) it refuses even the bypass-listed founder's zero-approval merge; the REST endpoint honors the bypass. Do NOT delete the branch here — the branch deletion will fail from inside the worktree and break the flow (step 7 deletes it explicitly).

If the merge is refused, the error body names the unmet requirement (checks pending / review required) — stop and investigate before retrying.

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
