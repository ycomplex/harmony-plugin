// B-720 (replacement capture): `harmony leg-output record` — the node subprocess accessor
// container/provision.sh uses to record WHAT THE WORKER ITSELF WROTE, from inside the container.
//
// This exists because the daemon cannot do it. The daemon's capture is a ring buffer over the
// LAUNCH COMMAND's stdout, which is the worker's only on the docker profile; on the cloud profile
// (the one production runs) the launch command is a Cloud Run control-plane client and the worker's
// output goes to Cloud Logging, never through the daemon. Captured HERE, on the worker's own side,
// it is the worker's output on every profile — and the row says so, via `source='worker'`, so the
// web can select worker output by the producer label rather than by squinting at the content.
//
// Reached from bash exactly as B-916 reaches `harmony leg-cost record` (src/cli/commands/
// leg-cost.ts), and for the same architectural reason: worker-side capture belongs on the WORKER's
// side of the B-718 agent-neutrality seam. Nothing in this feature reads a byte of worker output for
// a control decision — the exit code remains the only signal out of a worker (see
// src/daemon/scheduler.ts's SchedulerDeps.runCommand guardrail comment). This is capture for
// DISPLAY.
//
// Deliberately NOT wired through runCommand (src/cli/run-command.ts): the subcommand is best-effort
// and must NEVER fail the leg that calls it, so runCommand's error-to-exit-1 shape is exactly wrong
// here. Same reasoning as leg-cost.ts's and model.ts's own header notes.
//
// It ALWAYS exits 0, and prints its diagnostics to STDERR ONLY — the strongest form of that rule in
// this repo, because here stdout IS the thing being captured: a stray stdout line from this accessor
// would corrupt the very operator tail it exists to record.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConductionId } from '../../config/run-config.js';
import { resolveLegCostContext } from '../../tools/leg-cost-record.js';
import {
  recordLegOutput,
  boundedTail,
  LEG_OUTPUT_TAIL_BYTES,
  type LegOutputSource,
} from '../../tools/leg-output-record.js';
import { getAuthenticatedContext } from '../auth.js';

/** Best-effort authenticated client, or null when this process has no login/config to authenticate
 *  with. NOT a WARNING-worthy event on its own — mirrors leg-cost.ts's `getClient` exactly: an
 *  unauthenticated environment running `harmony leg-output record` is an ordinary shape (a dogfood
 *  container, a local script), and the consumer below degrades silently to "nothing recorded". */
async function getClient(): Promise<SupabaseClient | null> {
  try {
    const { client } = await getAuthenticatedContext();
    return client;
  } catch {
    return null;
  }
}

const SOURCES: readonly LegOutputSource[] = ['worker', 'launcher'];

/** Read one capture file, or null when it cannot be read. An unreadable/absent file is NOT an
 *  error worth failing anything over — the invocation may have died before writing a byte — but it
 *  IS worth one stderr line, because a capture that silently records nothing looks identical to a
 *  worker that silently said nothing. */
function readCapture(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err: unknown) {
    console.error(
      `harmony leg-output record: WARNING — could not read the capture file ${path} ` +
        `(${(err as { message?: string })?.message ?? String(err)}); it contributes nothing to this row`,
    );
    return null;
  }
}

export function registerLegOutputCommands(program: Command): void {
  const legOutput = program
    .command('leg-output')
    .description(
      "B-720 worker-output capture — the ONE place container/provision.sh records what a leg's " +
        '`claude` invocation actually wrote, from inside the container where it is genuinely the ' +
        'WORKER\'s output on every launch profile. Capture for DISPLAY only: nothing the daemon ' +
        'decides ever reads these rows.',
    );

  legOutput
    .command('record')
    .description(
      "Record ONE invocation's captured output as a conduction_leg_output row. Reads the given " +
        'capture file(s), stores the LAST 64 KB as the tail and the TOTAL byte count alongside it ' +
        '(so the board can say "showing the last N of M"), and stamps the producer as ' +
        '`--source` (default: worker). Always exits 0 and NEVER throws: a missing conduction id, ' +
        'an unreadable capture, an unreachable board or a not-yet-migrated table all degrade to ' +
        '"nothing recorded" with one STDERR warning. Diagnostics never touch stdout — stdout is ' +
        'the thing being captured. The leg is never affected.',
    )
    .requiredOption('--file <path>', "The file this invocation's stdout was captured to")
    .option('--stderr-file <path>', "The file this invocation's stderr was captured to, appended after the stdout capture")
    .requiredOption('--leg-key <key>', "The worker-generated key grouping this leg's invocations (the SAME key `leg-cost record` is given, so a leg's output and cost join)")
    .option('--gate <gate>', 'The gate that was running when the invocation STARTED (see `leg-cost resolve-gate`)')
    .option('--source <source>', "Who wrote these bytes: 'worker' (default) or 'launcher'", 'worker')
    .option('--conduction-id <id>', "The conduction to record against; defaults to this worker's HARMONY_CONDUCTION_ID")
    .action(
      async (opts: {
        file: string;
        stderrFile?: string;
        legKey: string;
        gate?: string;
        source?: string;
        conductionId?: string;
      }) => {
        const conductionId = opts.conductionId ?? getConductionId();
        if (!conductionId) {
          // Not a conducted leg (a manual/dogfood container run) — there is no conduction for the
          // row to belong to. A SKIP, not a failure; see recordLegOutput's own contract.
          return;
        }

        // An unrecognized source falls back to 'worker' rather than dropping the capture: this
        // accessor's only caller IS the worker, so a typo must cost a warning, never a leg's
        // output. The DB's CHECK is the real guard against a bogus label ever landing.
        let source: LegOutputSource = 'worker';
        if (opts.source && (SOURCES as readonly string[]).includes(opts.source)) {
          source = opts.source as LegOutputSource;
        } else if (opts.source && opts.source !== 'worker') {
          console.error(
            `harmony leg-output record: WARNING — unknown --source '${opts.source}' ` +
              `(expected ${SOURCES.join(' | ')}); recording as 'worker'`,
          );
        }

        // stdout first, then stderr — the order an operator reading a terminal would have seen
        // them, minus the live interleaving that a two-file capture cannot reconstruct. A file
        // that could not be read contributes nothing rather than aborting the row: half a capture
        // is worth strictly more than none.
        const parts = [readCapture(opts.file)];
        if (opts.stderrFile) parts.push(readCapture(opts.stderrFile));
        const captured = parts.filter((p): p is string => p !== null).join('');

        // The TOTAL is what the invocation emitted, not what is retained — their difference is
        // exactly the "showing the last N of M bytes" signal, so it is computed BEFORE bounding.
        const totalBytes = Buffer.byteLength(captured, 'utf8');
        const tail = boundedTail(captured, LEG_OUTPUT_TAIL_BYTES);

        const client = await getClient();
        // Reuses B-916's context read verbatim (ONE query for the owning task) rather than
        // standing up a second identical one — the two features want the same denormalized
        // task_id off the same parent conduction.
        const context = await resolveLegCostContext(client, conductionId);

        await recordLegOutput(client, {
          conduction_id: conductionId,
          source,
          leg_key: opts.legKey || null,
          task_id: context?.task_id ?? null,
          gate: opts.gate || null,
          tail,
          total_bytes: totalBytes,
        });
      },
    );
}
