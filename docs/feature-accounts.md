# Current feature accounts

B-1234 establishes the account contract consumed by B-1235 (maintenance) and B-1236 (rendered records). An account describes live production behaviour; accepted ticket decisions remain separate. No historical account backfill runs.

An account has a stable `account_id`, backing knowledge `entry_id`, project, normalized lowercase `owner_surface`, and optional workspace `concept_id` (the existing concept entity UUID shared with B-1226). Identity creation is idempotent by project/surface; revision zero has no live text. Different surfaces may reference the same concept.

## Shared MCP and CLI operations

The MCP tools and `harmony knowledge accounts` commands use the same handlers:

| MCP | CLI | Meaning |
|---|---|---|
| `create_feature_account` | `accounts create --surface <surface> [--concept <uuid>]` | Create identity; never publish proposed text |
| `read_feature_accounts` | `accounts list [--account <uuid>] [--surface <surface>] [--history-before <revision>] [--history-limit <n>]` | Read live clauses/text, ordered pending amendments and newest-first history |
| `preview_feature_amendment` | `accounts preview --file <json>` | Validate and preview operations without writes; `live: false` |
| `propose_feature_amendment` | `accounts propose --file <json>` | Register an idempotent pending replacement from an accepted source decision and same-project ticket |
| `apply_feature_amendment` | `accounts apply <uuid> --production-event <uuid>` or `--confirm-production` | Publish after production rollout; the confirmation is an intentional post-promotion operator action |

Preview takes `account_id`, `expected_revision` and ordered `operations`. A proposal adds `source_decision_id`, `source_task_id`, `idempotency_key`, explicit `leaves_untouched` and optional `evidence: {pr_url, commit}`. Every source must be accessible in the account's project. Backing account entries cannot themselves serve as amending ticket decisions.

```json
{
  "account_id": "<uuid>",
  "expected_revision": 1,
  "operations": [{"op":"replace","clause_id":"board-view","content":"Updated production behaviour."}],
  "leaves_untouched": [{"owner_surface":"settings"}, {"clause_id":"list-view"}],
  "source_decision_id": "<accepted-decision-uuid>",
  "source_task_id": "<ticket-uuid>",
  "idempotency_key": "ticket-change-1",
  "evidence": {"pr_url":"https://github.com/owner/repo/pull/1","commit":"<sha>"}
}
```

Replace names an existing clause and preserves its position. Insert names a new stable clause ID and an explicit final `ordinal` (1-based). Operations run in the given order. Duplicate targets, duplicate insertion positions, missing targets and target/untouched overlap fail. Unaffected clauses retain exact text and relative order. `leaves_untouched` is persisted audit scope, never write authority over neighbours.

The database locks source then account, rechecks source acceptance/project access and expected revision, and updates the clauses, projection, complete immutable revision snapshot, applied status and per-clause events in one transaction. The old snapshot remains in history. A failed final event write rolls everything back. Same proposal key with changed payload fails; a successful application retry returns before its revision check and produces no extra history/events. Another amendment based on an older revision stays pending and needs a new rebased proposal/key.

## Production cutover and event timing

Proposal records `knowledge_events.event_type=decision-updated`, `metadata.kind=amendment-proposed`. Publication records one `decision-updated` / `metadata.kind=amended` event per affected clause with `clause_id`, `source_task_id`, `source_decision_id`, `account_id`, `amendment_id`, `proposal_event_id`, `changed_fields` and old/new revisions. The account backing entry is `decision_id`; `tx_id` groups generic companions. B-1239 can label the change without guessing.

B-1229's nested producer insert (`source=trigger`, `kind=re-stamped`, old rollout state not live, new state live) registers a trusted cutover. The account consumer verifies the decision's actual `rollout_state=live`, and uses the event's `created_at`, never `verified_against.at`. A client-inserted lookalike event cannot register a trusted cutover. The event ledger trusts producer events observed after this migration; older unproven events require the explicit post-promotion fallback. Event-based publication also rechecks that the source is still production-live. An automatic stale-revision conflict leaves that proposal pending rather than preventing a real production stamp. Other application failures remain visible and transactional.

Until the producer is deployed, an explicit post-promotion apply records operator, action time and live state. Never infer production from merge, Built, Deployed, Verified or staging. An already-recorded trusted event can be passed explicitly when a proposal arrives after rollout. B-1235 owns automatic authorship; this ticket does not hook gate acceptance to proposal creation.

## Retrieval and rollout

Read results contain `availability` (`available`, `not-found`, or `unavailable`) and `accounts`. Each account contains `current_revision`, live `current_text`, ordered `clauses`, separately labelled `pending_amendments` and immutable `history`. Pending cards include source, untouched scope and revision-conflict state. History is newest first; pass the last revision as exclusive `history_before` for the next page (limit 1–100). Authorization and project scope apply before paging.

The Knowledge reader shows live text first, pending cards separately, and one collapsed Sources & history block. A revision-zero account explicitly says no live account yet. There is no browser editor.

Web's additive migration precedes plugin production promotion. A recognized missing account RPC/relation yields `unavailable` on reads; permission/network errors remain errors. Unsupported writes fail without fallback. Capability absence is never cached. Ordinary decision readers keep working throughout the staging-plugin/old-production window. PRs change neither plugin version nor `dist/`; CI generates the staging release. Production promotion remains a separate human action.
