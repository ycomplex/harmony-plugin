---
name: finish-work
description: Use when the user wants to finish, complete, wrap up, land, or merge their current work. Triggers on phrases like "finish", "done", "wrap up", "land this", "merge", "ship it", or "we're done". In manual-mode projects this is the exit point for development work — it handles the full merge-and-cleanup sequence, exactly as before. In opinionated-mode projects, /harmony-conduct is the entry point that drives the whole lifecycle; this skill implements the release (merge + deploy) and verify gates the conductor delegates to, and your explicit invocation ("finish work" / "land it" / "merge it") is how the release gate is crossed.
allowed-tools: mcp__harmony__* Read Grep Glob Bash Bash(gh *)
disallowed-tools: mcp__harmony__record_decision mcp__harmony__supersede_decision mcp__harmony__update_knowledge_entry
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
    doc: { decide: "Does the umbrella work end-to-end across its children?", items: [
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
     doc: { decide: "Release <ticket> — merge PR <pr_number> and deploy to staging?",
       context: [
         "The prior acceptance wasn't recorded — please re-affirm.",
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

Prefer this path-derived signal over any prose-derived set — the path signal is high-precision and avoids the
prose false-positives B-516 fixed.

**Approval-required line on a bot-authored PR (B-732).** A daemon-built PR is authored by the
`harmony-daemon` App, and GitHub forbids a PR author approving its own PR — so the merge cannot happen on
the human's Harmony accept alone. Check `gh pr view <pr_number> --json author` for the `build_pr` PR; if
`author.is_bot` is true, add a second attention line alongside the risk signal, naming the PR:

> *"⚠ This PR is authored by `harmony-daemon[bot]` and needs your approval on GitHub before it can merge:
> `<pr_url>`. Accepting here is your go-ahead; the merge runs once the approval lands."*

Say it on the brief rather than only at the merge, so the human can approve while they are already looking
at the release decision instead of being stopped afterwards. On the human's **accept**:

```
mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })   // pending_activity: null → clears the flag, NO state change
```

`provenance: "human-in-session"` is the human's decision, made here (B-734) — and it is the **only** value
this gate can ever carry from the plugin: release is the hard floor, so the conductor never synthesizes it
(`skills/harmony-shared/gate-routing.md` §Resolution provenance). That accept is also what writes the
`brief_resolved` entry a later resume reads at the top of this section.

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

**Branch on `field_values.build_pr`** (B-722's recorded pushed-PR reference — shape `{ branch, head_sha,
pr_number, pr_url, base: "main", opened_at }`) to decide how to land the code. This is what makes O2 work
for a daemon-built PR whose worktree is long gone by the time release runs (it was built inside an ephemeral
`--rm` container) — the LOCAL-WORKTREE precondition is no longer a hard requirement, it's just one of three
paths:

- **`build_pr` present (the common case — daemon- or human-built, B-722 recorded it):** merge it via the
  REST endpoint already established for the bypass floor (B-712), directly — **no local worktree required:
  no checkout, no rebase, no force-push.**
  1. **Wait for CI** — `gh pr checks <pr_number> --watch`. The checks already ran against the pushed head
     from the build step; there is no rebase/force-push here to re-trigger them.
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
  2. **Squash-merge** — `gh api -X PUT "repos/{owner}/{repo}/pulls/<pr_number>/merge" -f merge_method=squash`
     (the same REST form as the manual-mode flow below — `gh pr merge`'s GraphQL path still does not honor
     `bypass_pull_request_allowances` under the required-review merge floor, B-695). `gh` resolves
     `{owner}/{repo}` from the git remote of whatever directory the command runs in, not from a specific
     checked-out branch — running it from the project root, or any clone of the repo, is sufficient.
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

```
mcp__harmony__compose_brief({
  task_id, reason: "verification-ack-pending", pending_activity: "verifying",
  doc: { decide: "Does production behaviour match the design?", items: [{ kind: "decision", text: "Acknowledge verified", recommendation: "verify once confirmed" }] }
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

**Land the verify result on the ticket (B-560) — NON-OPTIONAL.** Immediately after the accept, comment
the verify outcome so the ticket carries the closing leg of the build→release→verify trail as durable
evidence:

```
mcp__harmony__add_comment({ task_id, content: "Verified — production behaviour matches the design (human-acked <date>)." })
```

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
gh pr checks <PR-number> --watch
```

If CI fails, stop and investigate — do not merge a failing build.

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
