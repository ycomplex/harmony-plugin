// B-720 (replacement capture): the per-leg WORKER-OUTPUT record's shared-core accessors.
//
// WHAT WENT WRONG, and what this replaces. B-720 originally captured "worker output" in the daemon,
// by ring-buffering the stdout of the LAUNCH COMMAND into `conductions.last_worker_output*`. On the
// docker profile the launch template ends in an attached `docker run`, so that stdout genuinely is
// the worker's. On the CLOUD profile — the only one production runs — the launch command is a Cloud
// Run control-plane client (container/cloud-worker-launch.sh): the worker's stdout goes to Cloud
// Logging and never passes through the daemon at all, so the captured bytes were gcloud/launcher
// chatter wearing the name "worker output". A surface that confidently shows the wrong bytes is
// worse than one that shows none.
//
// The fix is to capture on the WORKER'S OWN SIDE and to NAME THE PRODUCER in the row:
//   * `source: 'worker'` — written from INSIDE the container, once per claude invocation, by
//     container/provision.sh through the `harmony leg-output record` CLI accessor. This is worker
//     output on every profile, because nothing about it is inferred from what the daemon happened
//     to be attached to.
//   * `source: 'launcher'` — the daemon's existing 64 KB ring buffer, kept but relabelled as what it
//     always was (src/daemon/scheduler.ts's `flushLaunchOutput`). It is the worker's output ONLY on
//     the docker profile.
// The web selects worker output by `source` ALONE: launcher bytes are excluded by the QUERY, never
// by inspecting content — content is exactly the thing that is not self-identifying here. Persisted
// in `public.conduction_leg_output` (harmony-web's B-720 replacement migration).
//
// THE AGENT-NEUTRALITY SEAM is unchanged (read src/daemon/scheduler.ts's SchedulerDeps.runCommand
// guardrail comment before touching this file). No scheduling, classification, retry or park
// decision has ever read, or may ever read, a single byte of what a worker wrote: the exit code is
// still the ONLY control signal out of a worker. Everything here is CAPTURE FOR DISPLAY. Unlike
// B-916's sibling module this one IS reached from src/daemon/ — but only as an injected
// SchedulerDeps write of the daemon's OWN launch-command bytes, never as a read, and never on a
// decision path.
//
// These are IN-PROCESS shared-core functions, following src/tools/conduction-record.ts's convention
// exactly: deliberately NOT registered as MCP tools, exported through the src/tools barrel only, and
// consumed by the CLI accessor (src/cli/commands/leg-output.ts) as a plain function call over an
// authenticated Supabase client.
//
// NEVER THROWS (B-846 tolerance) — the same discipline, for the same reason, as
// src/tools/leg-cost-record.ts: harmony-web's migration creating `conduction_leg_output` merges and
// promotes on its OWN schedule, so between this plugin merging and that promotion every write here
// is rejected by PostgREST with a table-absent error. An output capture is a diagnostic nicety; it
// must never be able to fail a leg or a settlement, before or after the migration lands. Every
// failure — a missing table, an RLS refusal, a network blip, an absent conduction id — is logged to
// stderr and dropped.

import type { SupabaseClient } from '@supabase/supabase-js';

/** WHO WROTE THE BYTES. The one controlled vocabulary in this feature, CHECK-constrained in the DB
 *  too: the UI's entire selection rule is `source === 'worker'`, so a third unreviewed value must
 *  never be able to appear behind it. */
export type LegOutputSource = 'worker' | 'launcher';

/** The hard cap on how much of a leg's output is retained for display: 64 KB, the SAME bound the
 *  daemon's ring buffer has always used (src/daemon/scheduler.ts's WORKER_OUTPUT_TAIL_BYTES —
 *  deliberately re-declared rather than imported, because src/tools must not depend on src/daemon).
 *  Enough to hold the end of a run (the stack trace / the last few tool calls / the "I'm parking
 *  because…" line) without turning a conduction row into a log store. */
export const LEG_OUTPUT_TAIL_BYTES = 64 * 1024;

/** One row of `public.conduction_leg_output`. Column-for-column the shape harmony-web's B-720
 *  replacement migration creates; keep the two in step. */
export interface LegOutputRecord {
  id: string;
  conduction_id: string;
  task_id: string | null;
  /** The leg this output belongs to, as the WORKER named it — the same key B-916's
   *  `conduction_leg_costs` rows carry, so a leg's output and its cost join. NULL on every launcher
   *  row: the daemon does not know the worker-minted key (the worker mints it inside the container,
   *  after the launch command has already been rendered and fired). */
  leg_key: string | null;
  source: LegOutputSource;
  /** A bounded tail of what the producer emitted, VERBATIM. NULL = NOT CAPTURED — never "the
   *  producer said nothing", which is a different and stronger claim. */
  tail: string | null;
  /** The TOTAL bytes the producer emitted; greater than `tail`'s length exactly when the tail is
   *  partial. That difference is the "showing the last N of M" signal the board states. */
  total_bytes: number | null;
  captured_at: string;
  gate: string | null;
}

const LEG_OUTPUT_COLS =
  'id, conduction_id, task_id, leg_key, source, tail, total_bytes, captured_at, gate';

/** Everything `recordLegOutput` needs. `conduction_id` and `source` are the only required fields:
 *  a capture that could read nothing must still be able to record THAT a leg produced no readable
 *  output, rather than nothing at all. */
export interface RecordLegOutputArgs {
  conduction_id: string;
  source: LegOutputSource;
  /** Worker rows always carry it; launcher rows cannot — see LegOutputRecord.leg_key. */
  leg_key?: string | null;
  task_id?: string | null;
  gate?: string | null;
  /** Already bounded by the caller, or bound it here with `boundedTail`. */
  tail?: string | null;
  total_bytes?: number | null;
  /** Normally omitted so the DB's `now()` default stamps the row. Supplied only by callers that own
   *  an injected clock (the daemon's scheduler, whose whole test world runs on a fake one). */
  captured_at?: string | null;
}

/** One WARNING line, stderr only — this module's single failure channel. Mirrors
 *  src/tools/leg-cost-record.ts's `warn` convention: name the cause AND say plainly that the
 *  pre-migration shape is expected, so nobody debugs a non-bug. NEVER stdout: the CLI accessor
 *  around this runs inside a worker whose stdout is the very thing being captured — a stray stdout
 *  line would corrupt the capture it describes. */
function warn(message: string): void {
  console.error(`harmony leg-output: WARNING — ${message}`);
}

const errText = (err: unknown): string =>
  (err as { message?: string })?.message ?? String(err);

/** The last `limitBytes` BYTES of `text`, cut on a character boundary.
 *
 *  Binary-searches the smallest start index whose remaining slice fits the bound (byte length is
 *  monotone in the start index), so a multi-byte codepoint is never split in half the way a raw
 *  Buffer slice would split it. Returns `text` unchanged when it already fits — the common case,
 *  and the one where the board must say nothing about truncation. */
export function boundedTail(text: string, limitBytes: number = LEG_OUTPUT_TAIL_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(text.slice(mid), 'utf8') > limitBytes) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(lo);
}

/** Insert ONE captured-output row. Returns whether the row actually landed.
 *
 *  NEVER THROWS — see the module header. A missing `conduction_id` (no HARMONY_CONDUCTION_ID in the
 *  worker's env: a manual/dogfood container run rather than a conducted leg) is a SKIP, not a
 *  failure: there is no conduction for the row to belong to, so there is nothing to record and
 *  nothing has gone wrong. Every other failure — the table not existing yet (the expected
 *  pre-migration shape), an RLS refusal, a network blip — logs one WARNING and returns false.
 *
 *  An EMPTY tail is stored as NULL, deliberately: "" and "nothing captured" render identically to a
 *  reader, and NULL is the one the board already knows how to state honestly. */
export async function recordLegOutput(
  client: SupabaseClient | null | undefined,
  args: RecordLegOutputArgs,
): Promise<boolean> {
  if (!client) return false;
  if (!args.conduction_id) return false;
  if (!args.source) return false;

  try {
    const tail = args.tail ?? null;
    const row: Record<string, unknown> = {
      conduction_id: args.conduction_id,
      task_id: args.task_id ?? null,
      leg_key: args.leg_key ?? null,
      source: args.source,
      tail: tail !== null && tail.length > 0 ? tail : null,
      total_bytes: args.total_bytes ?? null,
      gate: args.gate ?? null,
    };
    // Omitted entirely when the caller has no clock of its own, so the column's `now()` default
    // stamps it — a null here would violate the NOT NULL and lose the row.
    if (args.captured_at) row.captured_at = args.captured_at;

    const { error } = await client.from('conduction_leg_output').insert(row);
    if (error) {
      warn(
        `the ${args.source} output row was not written (${errText(error)}). This is the EXPECTED ` +
          "shape while harmony-web's conduction_leg_output migration has not yet landed on this " +
          "environment's Supabase project (B-383 prod-before-promote) — the leg itself is unaffected.",
      );
      return false;
    }
    return true;
  } catch (err: unknown) {
    warn(`writing the ${args.source} output row threw (${errText(err)}) — the leg itself is unaffected`);
    return false;
  }
}

/** Read back one conduction's captured-output rows, NEWEST FIRST — optionally narrowed to ONE
 *  source. Newest-first because every consumer wants "the latest row for this producer"; the web's
 *  own read (src/features/conductors/hooks/useConductionLegOutput.ts) does the same. Never throws:
 *  returns `[]` on any failure (including the table not existing yet), for the same reason the write
 *  swallows. */
export async function listLegOutput(
  client: SupabaseClient | null | undefined,
  args: { conduction_id: string; source?: LegOutputSource },
): Promise<LegOutputRecord[]> {
  if (!client || !args.conduction_id) return [];
  try {
    let query = client
      .from('conduction_leg_output')
      .select(LEG_OUTPUT_COLS)
      .eq('conduction_id', args.conduction_id);
    if (args.source) query = query.eq('source', args.source);
    const { data, error } = await query.order('captured_at', { ascending: false });
    if (error) {
      warn(`could not read leg output for conduction ${args.conduction_id} (${errText(error)})`);
      return [];
    }
    return (data as unknown as LegOutputRecord[]) ?? [];
  } catch (err: unknown) {
    warn(`reading leg output for conduction ${args.conduction_id} threw (${errText(err)})`);
    return [];
  }
}
