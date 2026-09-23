// B-1062 step 3 — the daemon-side drain for `recorded_walk_requests` (B-1063's sibling table, the
// harmony-web "Record" action's write side — see docs/recorded-walk-contract.md for the full contract
// both repos build against).
//
// A poll/lease step wired into the daemon's own loop (src/bin/daemon.ts, via `SchedulerDeps.drainRecordedWalkRequests`
// — see scheduler.ts's own doc comment on that field for why it is OPTIONAL there). Each pass:
//   1. reads pending `recorded_walk_requests` rows,
//   2. claims ONE row at a time with a conditional `UPDATE ... WHERE status = 'pending'` (an atomic
//      per-row claim — no separate lease/token column needed; see docs/recorded-walk-contract.md),
//   3. runs the SAME gate-walk core a `harmony record` CLI/MCP call would (`runRecordedWalk`,
//      record-walk.ts) — ONE implementation, never a second one reimplemented here,
//   4. writes the outcome back (`status: 'done' | 'error'`, `processed_at`, `error`).
//
// TOLERANT OF THE TABLE NOT EXISTING YET (the B-846 precedent — see conduction-record.ts's
// `isMissingLastLegEndedAtColumn` / scheduler.ts's `writeLastLegEndedAt` for the sibling shape this
// mirrors): B-1063 (harmony-web's migration) may not have shipped yet when this code merges and reaches
// the live daemon (plugin `main` -> `staging` -> the daemon host's `git pull`, well ahead of any
// particular web migration's own promotion — see the workspace CLAUDE.md's propagation table). A query
// against `recorded_walk_requests` failing because the relation doesn't exist logs ONE loud,
// clearly-named skip line per pass and returns — NEVER throws, NEVER crashes the daemon loop.
//
// ZERO WORKER LEGS, BY CONSTRUCTION: this drain calls `runRecordedWalk` DIRECTLY, in-process — it never
// spawns `claude -p` / any container launch, and so it writes no `conduction_leg_costs` row (that table
// is written only from the leg-launching path — `leg-cost-record.ts` / `claude-result-parse.ts`, per
// container/provision.sh's post-invocation call — which this module never imports; see
// recorded-walk-drain-contract.test.ts for the structural + runtime proof).

import type { SupabaseClient } from '@supabase/supabase-js';
import { runRecordedWalk, type RecordWalkArgs, type RecordWalkResult } from '../tools/record-walk.js';

export const RECORDED_WALK_REQUESTS_TABLE = 'recorded_walk_requests';

export interface RecordedWalkRequestRow {
  id: string;
  task_id: string;
  summary: string;
  evidence_links: Array<{ url: string; repo?: string; paths?: string[] }>;
  attest_walk: string | null;
  requested_by: string;
  requested_at: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  processed_at: string | null;
  error: string | null;
}

/** The B-383/B-846-class schema-drift predicate for THIS table specifically — never matches a
 *  permission error or a transient network failure, only "the relation does not exist yet". */
export function isMissingRecordedWalkRequestsTable(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  const msg = err.message ?? '';
  return new RegExp(RECORDED_WALK_REQUESTS_TABLE).test(msg) && /(does not exist|could not find|schema cache)/i.test(msg);
}

export interface RecordedWalkDrainDeps {
  client: SupabaseClient;
  projectId: string;
  /** The acting user id the gate-walk core's writes are attributed to (e.g. a daemon service account,
   *  or the human named in `requested_by` — B-1063's own migration/RLS design decides which; this
   *  drain takes it as an injected value rather than guessing). */
  userId: string;
  log: (line: string) => void;
}

const LOG_PREFIX = '[recorded-walk-drain]';

/** ONE drain pass: claim and process AT MOST ONE pending request (mirrors the scheduler's own
 *  one-row-at-a-time discipline elsewhere in this daemon — a batch drain is not needed at this
 *  volume, and keeping it singular keeps a single bad request from starving the rest of the pass
 *  budget). Returns the number of requests processed this pass (0 or 1), NEVER throws. */
export async function runRecordedWalkDrainPass(deps: RecordedWalkDrainDeps): Promise<number> {
  const { client, projectId, userId, log } = deps;

  let pending: RecordedWalkRequestRow[];
  try {
    const { data, error } = await client
      .from(RECORDED_WALK_REQUESTS_TABLE)
      .select('id, task_id, summary, evidence_links, attest_walk, requested_by, requested_at, status, processed_at, error')
      .eq('status', 'pending')
      .order('requested_at', { ascending: true })
      .limit(1);
    if (error) {
      if (isMissingRecordedWalkRequestsTable(error)) {
        log(`${LOG_PREFIX} ${RECORDED_WALK_REQUESTS_TABLE} table not found — skipping this pass (B-1063 not yet merged)`);
        return 0;
      }
      throw new Error(error.message);
    }
    pending = (data ?? []) as RecordedWalkRequestRow[];
  } catch (err) {
    // A non-relation-absence failure (network blip, RLS denial, etc.) is loud but non-fatal to the
    // daemon loop — exactly like every other per-row isolation in scheduler.ts. Never crash the loop.
    log(`${LOG_PREFIX} read failed — skipping this pass (${err instanceof Error ? err.message : String(err)})`);
    return 0;
  }

  if (pending.length === 0) return 0;
  const request = pending[0];

  // Claim: an atomic conditional UPDATE. `data` comes back non-empty only when THIS call's WHERE
  // clause actually matched a still-pending row — a peer daemon racing the same row loses cleanly
  // (its own claim affects 0 rows) rather than double-processing.
  const { data: claimed, error: claimErr } = await client
    .from(RECORDED_WALK_REQUESTS_TABLE)
    .update({ status: 'processing' })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr) {
    log(`${LOG_PREFIX} claim failed for request ${request.id} — skipping this pass (${claimErr.message})`);
    return 0;
  }
  if (!claimed) {
    // Lost the race to a peer daemon — not an error, just nothing for THIS pass to do.
    return 0;
  }

  const args: RecordWalkArgs = {
    task_id: request.task_id,
    summary: request.summary,
    evidence: request.evidence_links ?? [],
    attest_walk: request.attest_walk ?? undefined,
  };

  let result: RecordWalkResult | undefined;
  let failureMessage: string | undefined;
  try {
    result = await runRecordedWalk(client, projectId, userId, args);
    if (result.refused) failureMessage = result.refusal_reason;
    else if (result.error) failureMessage = result.error;
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
  }

  const finalStatus: RecordedWalkRequestRow['status'] = failureMessage ? 'error' : 'done';
  const { error: writeBackErr } = await client
    .from(RECORDED_WALK_REQUESTS_TABLE)
    .update({ status: finalStatus, processed_at: new Date().toISOString(), error: failureMessage ?? null })
    .eq('id', request.id);
  if (writeBackErr) {
    // The walk's own outcome is already decided; a failure to WRITE BACK the status is reported but
    // does not itself throw — the request stays 'processing' for a human to notice and requeue by hand
    // rather than the daemon loop dying over a bookkeeping write.
    log(`${LOG_PREFIX} write-back failed for request ${request.id} — it stays 'processing' (${writeBackErr.message})`);
  }
  if (failureMessage) {
    log(`${LOG_PREFIX} request ${request.id} (task ${request.task_id}) failed: ${failureMessage}`);
  } else {
    log(`${LOG_PREFIX} request ${request.id} (task ${request.task_id}) recorded — ${result?.gates.length ?? 0} gate(s) landed`);
  }

  return 1;
}
