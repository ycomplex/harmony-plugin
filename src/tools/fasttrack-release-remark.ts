// B-1073 step 11 (post-review wiring) — release-accept-remark -> `recorded_walk_requests` auto-
// insert. REAL now, not a stub: grepping this plugin's `src/tools/` turns up MANY existing plain
// `client.from(<table>).insert(...)` call sites with no MCP-tool mediation layer in between
// (comments.ts's addComment, conduction-record.ts's createConduction, leg-output-record.ts,
// leg-cost-record.ts, ...) — this plugin's shared core plainly already has write access to
// arbitrary app tables via its one service-role Supabase client, so there is no capability gap to
// work around. The ONE missing piece was a REAL CALL SITE for THIS table specifically, which
// `fileFastTrackReleaseRemarkRecordedWalkIfEligible` below now is, called from
// `src/tools/briefs.ts`'s `consumeAcceptRemark` — the exact point `pending_remark` is actually
// consumed, server-side, on every accept-with-remark (release or otherwise).
//
// LIVES HERE, NOT IN `src/daemon/recorded-walk-drain.ts` (where this started life as a pure stub):
// that module imports `../tools/record-walk.js`, which imports `../tools/briefs.js` — so if the
// real call site (briefs.ts) imported the auto-insert logic FROM recorded-walk-drain.ts, the result
// would be an import cycle (briefs.ts -> recorded-walk-drain.ts -> record-walk.ts -> briefs.ts).
// This module has no such dependency (only conduction-record.ts + run-config.ts, neither of which
// imports briefs.ts), so briefs.ts can import it directly. recorded-walk-drain.ts re-exports these
// three names for backward compatibility with its own pre-existing tests/imports.
//
// THE IDEA (per B-1073's ratified design, unchanged): when a fast-track ticket's RELEASE brief is
// accepted WITH a remark (B-503's `pending_remark` — surfaced on `get_task` as `{ brief_id, reason,
// detail, decision_ref, referent }`), the remark's `detail` text IS the human's post-hoc
// verify-walk attestation — so the consume path files a `recorded_walk_requests` row treating it as
// `attest_walk`, continuing the fast-track ticket's walk through `harmony record`'s own gate-walk
// core without a second human action.
//
// `buildFastTrackReleaseRemarkRecordedWalkRequest` below stays the PURE row-shaping helper it always
// was (task_id/summary/evidence_links/attest_walk/requested_by — never the generated
// id/requested_at/status/processed_at/error/result columns, per B-1063's column contract,
// docs/recorded-walk-contract.md §5). `fileFastTrackReleaseRemarkRecordedWalkIfEligible` wraps it
// with the THREE live reads the decision actually needs (none of which existed when this was a
// stub): the brief's own `reason` (is this the RELEASE gate specifically?), the ticket's ACTIVE
// conduction's `run_config.fast_track` (is this ticket actually fast-tracked?), and the ticket's
// current `title` + `field_values.build_pr.pr_url` (what to file). NEVER THROWS — every failure
// (no active conduction, not fast-track, the table not existing yet pre-B-1063, a genuine write
// error) degrades to "filed nothing", because this is a side effect riding on the remark-consume;
// it must never be able to break the consume itself.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getActiveConduction } from './conduction-record.js';
import { isFastTrackEnabled, type RunConfig } from '../config/run-config.js';

// Deliberately a LOCAL literal, not imported from `src/daemon/recorded-walk-drain.ts`'s own
// `RECORDED_WALK_REQUESTS_TABLE` export — importing it would reintroduce the exact import-cycle
// this module's header exists to avoid. Small, stable, never-renamed table name; duplicating it
// here is the same accepted tradeoff `src/config/run-config.ts`'s own `DEFAULT_SUPABASE_URL` /
// `KNOWN_REFS_FOR_MODEL` duplication note documents.
const RECORDED_WALK_REQUESTS_TABLE = 'recorded_walk_requests';

/** The row shape `buildFastTrackReleaseRemarkRecordedWalkRequest` below produces — the INSERT-able
 *  columns only (see the module comment above for the generated columns this deliberately omits). */
export interface FastTrackReleaseRemarkRecordedWalkRequestRow {
  task_id: string;
  summary: string;
  evidence_links: Array<{ url: string }>;
  attest_walk: string;
  requested_by: string;
}

/** B-1073 step 11: shapes the `recorded_walk_requests` row a fast-track ticket's
 *  release-accept-with-remark files, from the remark + the ticket's already-recorded `build_pr`.
 *  Pure — no I/O. `remark_detail` is the B-503 `pending_remark.detail` text, taken VERBATIM as the
 *  walk's `attest_walk` sentence (per this ticket's own design: the remark IS the attestation).
 *  Returns `null` when `remark_detail` is blank/whitespace-only — an attestation cannot be empty
 *  (mirrors `evaluateVerifyWalkItem`'s own blank-reads-as-absent convention,
 *  `src/tools/record-eligibility.ts`). */
export function buildFastTrackReleaseRemarkRecordedWalkRequest(args: {
  task_id: string;
  task_title: string;
  remark_detail: string;
  build_pr_url: string | null;
  requested_by: string;
}): FastTrackReleaseRemarkRecordedWalkRequestRow | null {
  const attestWalk = args.remark_detail.trim();
  if (!attestWalk) return null;
  return {
    task_id: args.task_id,
    summary: args.task_title,
    evidence_links: args.build_pr_url ? [{ url: args.build_pr_url }] : [],
    attest_walk: attestWalk,
    requested_by: args.requested_by,
  };
}

/** B-1073 step 11 (post-review wiring) — the REAL call site's own entry point, called from
 *  `src/tools/briefs.ts`'s `consumeAcceptRemark` immediately after it stamps a brief's
 *  `accept_remark_consumed_at`. Three checks, in order, each a clean no-op (not an error) when it
 *  misses: (1) `reason` must be the RELEASE gate's own brief reason (`release-decision-pending`) —
 *  a remark consumed at any OTHER gate is not this ticket's concern; (2) the task's ACTIVE
 *  conduction (`getActiveConduction`, `src/tools/conduction-record.ts`) must carry
 *  `run_config.fast_track: true` — an ordinary conducted ticket's release-accept remark files
 *  nothing here, by design (B-1073 is fast-track-only); (3) the remark text, trimmed, must be
 *  non-blank (delegated to `buildFastTrackReleaseRemarkRecordedWalkRequest`'s own guard). Returns
 *  `true` only when a row was actually inserted — NEVER throws, mirroring this whole module's
 *  degrade-to-null-never-throw posture (resolveRunConfigFromConduction's own convention, reused
 *  here for the same reason: a side effect riding on the remark-consume must never be able to break
 *  the consume itself). */
export async function fileFastTrackReleaseRemarkRecordedWalkIfEligible(
  client: SupabaseClient,
  args: { task_id: string; reason: string; remark_detail: string; requested_by: string },
): Promise<boolean> {
  const RELEASE_GATE_REASON = 'release-decision-pending';
  if (args.reason !== RELEASE_GATE_REASON) return false;
  if (!args.remark_detail.trim()) return false;

  try {
    const conduction = await getActiveConduction(client, args.task_id);
    const runConfig = (conduction?.run_config ?? {}) as RunConfig;
    if (!isFastTrackEnabled(runConfig)) return false;

    const { data: taskRow, error: taskErr } = await client
      .from('tasks')
      .select('title, field_values')
      .eq('id', args.task_id)
      .maybeSingle();
    if (taskErr || !taskRow) return false;

    const row = taskRow as { title?: string | null; field_values?: Record<string, unknown> | null };
    const buildPr = row.field_values?.['build_pr'] as { pr_url?: string } | undefined;

    const request = buildFastTrackReleaseRemarkRecordedWalkRequest({
      task_id: args.task_id,
      task_title: row.title ?? '',
      remark_detail: args.remark_detail,
      build_pr_url: buildPr?.pr_url ?? null,
      requested_by: args.requested_by,
    });
    if (!request) return false;

    const { error: insertErr } = await client.from(RECORDED_WALK_REQUESTS_TABLE).insert(request);
    if (insertErr) return false; // table absent pre-B-1063, RLS denial, or a genuine write failure — best-effort either way.
    return true;
  } catch {
    return false; // best-effort — never throws.
  }
}
