# Current feature accounts during design and build (B-1235)

Use this procedure when a ticket changes a feature's behaviour. B-1234 owns the
account store and production publication; this procedure authors **pending**
amendments only. A ticket's design decision remains a separate historical record.
`current_text` always describes live production behaviour. Acceptance, a successful
build, merge, staging, Deployed and Verified are never publication authority here.

## Capture the intent before the design brief

1. Read the ticket's accepted scope, affected feature/surface identities and
   Accepted decisions. Discover `read_feature_accounts`,
   `preview_feature_amendment` and `propose_feature_amendment` by capability, not
   version. Use the equivalent `harmony knowledge accounts` commands only if that
   CLI actually exposes them. Never invent a tool, RPC signature or raw SQL path.
2. Read each affected account by its exact owner surface or stable account id.
   Do not match an account solely by a similar title, and do not treat a concept
   definition or ticket decision as an account. Read live ordered clauses and
   separately labelled pending amendments; inspect history when reconciling a
   previously submitted proposal.
3. For each affected account name the stable clause ids being replaced, their
   current wording, replacement wording and explicit neighbouring clauses,
   accounts or surfaces **left untouched**. Preserve unrelated text and order.
   New clauses require explicit stable ids and insertion order. If the account
   does not exist, show that fact; propose a new identity/initial clause set only
   when covered by the decision, never silently manufacture live text.
4. Record the exact intent with `add_comment` **before composing the brief**, then
   include it in `doc.context` so acceptance actually ratifies it. Keep the
   authored `doc.claim` and the separate decision's claim; neither is replaced by
   account text. Do not add a new acceptance-event payload kind. A browser accept
   must leave enough information for a fresh worker to resume without guessing.

Use a fenced JSON record prefixed with `CURRENT-ACCOUNT-INTENT`, one per account
and source decision. This is a durable work specification, not a success marker:

```json
{
  "intent_id": "<stable ticket/decision/account/change identity>",
  "source_task_id": "<changing ticket UUID>",
  "source_decision_id": "<this separately recorded design decision UUID>",
  "owner_surface": "<exact affected surface>",
  "account_id": "<read account UUID, or null if not yet resolved>",
  "expected_revision": 3,
  "replaces": [{"clause_id": "behaviour", "before": "<live clause text>"}],
  "operations": [{"op": "replace", "clause_id": "behaviour", "content": "<replacement>"}],
  "leaves_untouched": [{"owner_surface": "<same surface>", "clause_id": "permissions"}],
  "idempotency_key": "<same stable intent identity>",
  "status": "awaiting-decision"
}
```

Unknown account/revision/clauses stay explicitly unresolved; do not use fabricated
values or submit that record. Resolve them from a successful read before writing.
An empty `leaves_untouched` is valid only when the brief explicitly says no
neighbouring scope exists. For inserts use `{op:"insert", clause_id, content,
ordinal}`. Each new intent names any earlier intent it replaces in the comment
and brief; do not discard another sub-track's independent account change.

A later sub-track that leaves the same behaviour unchanged reuses the original
accepted intent and source decision; it does not create a second proposal just
because it has its own decision id. Only a distinct ratified clause change gets a
new intent. Preserve the source decision that actually authorized each replacement.

If there is no affected feature, record `not-applicable` with the concrete scope
reason in the brief/build evidence. Missing capability is **blocked-unavailable**,
never `not-applicable` or “no account”. Continue ordinary discovery/build work, but
carry the unfinished maintenance as a checklist step and release attention item.

## Reconcile accepted intents

Run after design acceptance **and event consumption**, on fresh design pickup,
at plan/build pickup, and before composing release evidence. This includes a web
accept with no session running, a non-last design sub-track accept and a worker
restart. Read the ticket's comments and `list_ticket_knowledge`; consume any pending
acceptance event through the owning skill's normal path first.

For each unsuperseded intent:

1. Read its separate source decision in full. Require it to be **Accepted** and
   belong to this ticket/project. Confirm the ratified decision actually contains
   this intent. An Asserted, deferred, superseded or rejected draft cannot propose
   an amendment. A pre-compose intent left by a crash is not evidence of acceptance.
   Missing or ambiguous ratification is an elicitation question, not permission to
   infer replacements. Older decisions without an intent must have their proposed
   clause changes explicitly confirmed before submission.
2. Read the account afresh. Reconcile existing pending amendments/history and any
   `CURRENT-ACCOUNT-RESULT` records. If the same intent already has a confirmed
   pending/applied amendment, reuse its id and status; never create another merely
   to add build evidence. Fetch more history pages when needed before concluding
   absence. An already-applied amendment is an observed publication by the
   foundation, not publication performed by this procedure.
3. Verify the saved revision and exact clause targets still match. Do not silently
   replace the expected revision with the newest number. Stale/missing/overlapping
   targets are `blocked-conflict`: show the conflicting clauses and seek a rebase
   decision. Changed wording or targets need an explicitly ratified refinement
   and a new intent/key; the original successful request's key and payload stay
   immutable. Never retarget a clause by ordinal or fuzzy text similarity.
4. Call `preview_feature_amendment` with `account_id`, `expected_revision` and the
   exact `operations`. The preview must preserve every unrelated clause and order;
   a preview is not a write or a live account. Refuse to submit when the preview
   disagrees with the accepted scope.
5. Call `propose_feature_amendment` with these exact fields:

   ```text
   account_id, expected_revision, operations, leaves_untouched,
   source_task_id, source_decision_id, idempotency_key
   ```

   Optional `evidence: {pr_url, commit}` contains only already-verified build
   artefacts. **Before submitting**, persist the exact argument object in a
   `CURRENT-ACCOUNT-REQUEST` comment keyed by `intent_id`, then send that saved
   object. This ordering lets retries after a crash or lost response use **the
   identical payload**, including evidence, even when no result was recorded.
   Do not regenerate a key per session/gate or change evidence under a used key.
   A proposal records `amendment-proposed`, never `amended`; successful submission
   does not claim publication, a history revision or a change to `current_text`.
6. Read back the account and record the returned amendment id, source links,
   expected revision and pending status in a `CURRENT-ACCOUNT-RESULT` comment keyed
   by `intent_id`. Confirm the proposal is pending separately from live text.
   An uncertain response is `needs-readback`, not success; reconcile/read back or
   retry the identical idempotent request before marking the step done. If a
   production publication occurred independently, report its actual history
   evidence without claiming this proposal changed production.

Never call `apply_feature_amendment`, pass `confirm_production`, fabricate a
production event, or write `current_text`/backing entry content in this procedure.
Never fall back to `update_knowledge_entry`, brief projection writes or direct
table updates for an account. B-1111's locked ordinary-entry amendment and B-1136's
authored claim envelope still govern edits to the separate ticket decision; they
are not alternate account writers.

## Failures are visible work, not successful maintenance

- **Tools absent or `availability=unavailable`:** record `blocked-unavailable` and
  the missing capability. Refuse the write explicitly. Re-probe next pickup;
  absence is not cached permanently. Do not interpret unavailable as not-found.
- **Available but not-found:** record `needs-account`. If creating identity/initial
  clauses was accepted, use the foundation's `create_feature_account`, read back
  its identity/revision and preview the explicit initial insert operations. This
  creates no live account text. Otherwise request the missing account/scope decision.
- **Stale revision, missing target or overlap:** record `blocked-conflict`; preserve
  the accepted intent and show what needs rebasing. No automatic widening/rewrite.
- **Permission, source rejection, network or other error:** preserve and report the
  actual error as `blocked-error` (or `needs-readback` for uncertain submission).
  Do not relabel it unavailable or success, retry without bounds, or use broader
  credentials. Re-read the authoritative account before a retry.

Each blocked result includes the changing ticket, separate decision and affected
surface/account, the unsubmitted intent or exact uncertain request, and what must
change before retry. Keep the maintenance checklist item incomplete. A comment is
not a deferral destination: before release use disposition-discipline.md to fold
the retry into a live ticket's AC/scope or another terminal outcome, and surface
that disposition on the release brief. Do not declare the maintenance criterion
satisfied while its required proposal is still blocked.

## Design, build and release handoff

Design owns the accepted behaviour and clause intent. Build reconciles it against
what was implemented; a material difference goes through the existing design
revision/elicitation route before proposing different text. General observations
settled beyond design continue through knowledge-discipline.md (B-1143).

At plan time include a concrete checklist item to reconcile each affected account
and report proposal ids or blockers. At build pickup run the reconciliation above
even if a prior worker said design acceptance was consumed. At release, report
each account, separate decision, pending amendment id/status and verified PR/commit
links; add later build evidence as a comment alongside the existing proposal,
without mutating its idempotent payload or creating a duplicate amendment. State
that live text is unchanged by this workflow and publication remains production-gated.

`not-applicable` requires a scope reason; `pending` requires a read-back amendment;
blocked/uncertain work requires explicit disposition and attention. None of those
states may be described as “current account updated in production”.
