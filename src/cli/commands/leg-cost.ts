// B-916: `harmony leg-cost ...` — the node subprocess accessor container/provision.sh uses to
// record what each `claude` invocation cost, and to stamp WHICH GATE was running when it started.
//
// Reached from bash exactly as B-772 reaches `harmony model read-handoff` (src/cli/commands/
// model.ts), and for the same architectural reason: the claude-specific JSON parse
// (src/tools/claude-result-parse.ts) belongs on the WORKER's side of the B-718 agent-neutrality
// seam, never in src/daemon/. Nothing in this feature reads a byte of worker output for a control
// decision — the exit code remains the only signal out of a worker (see src/daemon/scheduler.ts's
// SchedulerDeps.runCommand guardrail comment). This is capture for DISPLAY.
//
// Deliberately NOT wired through runCommand (src/cli/run-command.ts): both subcommands are
// best-effort and must NEVER fail the leg that calls them, so runCommand's error-to-exit-1 shape is
// exactly wrong here. Same reasoning as model.ts's and config.ts's own header notes.
//
// EVERY subcommand here exits 0, always, and prints its diagnostics to STDERR only. provision.sh
// calls them between claude invocations inside a `set -euo pipefail` script whose stdout is B-720's
// captured operator tail; a nonzero exit or a stray stdout line from a cost accessor would be a
// diagnostic nicety corrupting the thing it is meant to describe.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConductionId } from '../../config/run-config.js';
import { resolveGatePhase } from '../../daemon/gate-phase.js';
import { parseClaudeResultJson, resolveCost } from '../../tools/claude-result-parse.js';
import { recordLegCost, resolveLegCostContext } from '../../tools/leg-cost-record.js';
import { getAuthenticatedContext } from '../auth.js';

/** Best-effort authenticated client, or null when this process has no login/config to authenticate
 *  with. NOT a WARNING-worthy event on its own — mirrors model.ts's `getCatalogClient` exactly: an
 *  unauthenticated environment running `harmony leg-cost ...` is an ordinary shape (a dogfood
 *  container, a local script), and every consumer below degrades silently to "nothing recorded". */
async function getClient(): Promise<SupabaseClient | null> {
  try {
    const { client } = await getAuthenticatedContext();
    return client;
  } catch {
    return null;
  }
}

export function registerLegCostCommands(program: Command): void {
  const legCost = program
    .command('leg-cost')
    .description(
      'B-916 per-invocation cost capture — the ONE place container/provision.sh records what each ' +
        '`claude` invocation of a leg cost, and resolves the gate to stamp on it. Capture for ' +
        'DISPLAY only: nothing the daemon decides ever reads these rows.',
    );

  legCost
    .command('resolve-gate')
    .description(
      "Print the gate this worker's conduction is currently running (clarify|decompose|design|" +
        'plan|build|release|verify), or an EMPTY line when it cannot be resolved (no ' +
        'HARMONY_CONDUCTION_ID, no login, an unreadable row, a terminal/unrecognized ' +
        'workflow_state). Always exits 0 — an empty result is a legitimate answer, never an error. ' +
        'Call this BEFORE the invocation it describes: by the time an invocation returns, the gate ' +
        'whose work it just did has already advanced, so resolving at write time would mis-name ' +
        'which activity spent the money.',
    )
    .option('--conduction-id <id>', "The conduction to resolve for; defaults to this worker's HARMONY_CONDUCTION_ID")
    .action(async (opts: { conductionId?: string }) => {
      const conductionId = opts.conductionId ?? getConductionId();
      if (!conductionId) {
        console.log('');
        return;
      }
      const client = await getClient();
      const context = await resolveLegCostContext(client, conductionId);
      // resolveGatePhase (src/daemon/gate-phase.ts) is the SHARED workflow_state -> gate projection
      // `harmony model resolve-gate` already uses — read, never re-derived here.
      console.log(resolveGatePhase(context?.workflow_state, context?.workflow_activity) ?? '');
    });

  legCost
    .command('record')
    .description(
      "Record ONE claude invocation's cost from its captured `--output-format json` stdout. Parses " +
        'the result envelope (keyed on `is_error`, NOT `subtype` — an errored run still reports ' +
        "subtype 'success'), resolves the cost (the CLI's own total_cost_usd, else the derived " +
        "price-table figure, else 'unknown'), and inserts one conduction_leg_costs row. Always " +
        'exits 0 and NEVER throws: a missing conduction id, an unparseable capture, an ' +
        'unreachable board or a not-yet-migrated table all degrade to "nothing recorded" with one ' +
        'stderr WARNING. The leg is never affected.',
    )
    .requiredOption('--file <path>', "The file this invocation's stdout was captured to")
    .requiredOption('--gate <gate>', 'The gate that was running when the invocation STARTED (see `resolve-gate`)')
    .requiredOption('--leg-key <key>', 'The worker-generated key grouping this leg\'s invocations')
    .option('--model <alias>', 'The model alias this invocation actually launched with')
    .option('--invocation-index <n>', "This invocation's 0-based position within the leg")
    .option('--conduction-id <id>', "The conduction to record against; defaults to this worker's HARMONY_CONDUCTION_ID")
    .action(
      async (opts: {
        file: string;
        gate?: string;
        legKey: string;
        model?: string;
        invocationIndex?: string;
        conductionId?: string;
      }) => {
        const conductionId = opts.conductionId ?? getConductionId();
        if (!conductionId) {
          // Not a conducted leg (a manual/dogfood container run) — there is no conduction for the
          // row to belong to. A SKIP, not a failure; see recordLegCost's own contract.
          return;
        }

        let captured: string;
        try {
          captured = readFileSync(opts.file, 'utf8');
        } catch (err: any) {
          console.error(
            `harmony leg-cost record: WARNING — could not read the capture file ${opts.file} (${err?.message ?? String(err)}); nothing recorded`,
          );
          return;
        }

        // A null parse is EXPECTED, not exceptional (an older CLI that ignored --output-format, a
        // stub, an invocation that died before emitting anything). The row is still written, with
        // no measurements: that an invocation happened at all is itself worth showing.
        const parsed = parseClaudeResultJson(captured);
        const model = opts.model || null;
        const cost = parsed
          ? resolveCost(parsed, model)
          : { total_cost_usd: null, cost_source: 'unknown' as const };

        const index = Number(opts.invocationIndex);
        // ONE client for both the context read and the write — authenticating twice per invocation
        // would double this accessor's cost for nothing.
        const client = await getClient();
        const context = await resolveLegCostContext(client, conductionId);

        await recordLegCost(client, {
          conduction_id: conductionId,
          leg_key: opts.legKey,
          task_id: context?.task_id ?? null,
          gate: opts.gate || null,
          model,
          invocation_index: Number.isFinite(index) ? index : null,
          input_tokens: parsed?.input_tokens ?? null,
          output_tokens: parsed?.output_tokens ?? null,
          cache_read_input_tokens: parsed?.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: parsed?.cache_creation_input_tokens ?? null,
          cache_creation_1h_input_tokens: parsed?.cache_creation_1h_input_tokens ?? null,
          cache_creation_5m_input_tokens: parsed?.cache_creation_5m_input_tokens ?? null,
          thinking_tokens: parsed?.thinking_tokens ?? null,
          total_cost_usd: cost.total_cost_usd,
          cost_source: cost.cost_source,
          num_turns: parsed?.num_turns ?? null,
          duration_ms: parsed?.duration_ms ?? null,
          duration_api_ms: parsed?.duration_api_ms ?? null,
          session_id: parsed?.session_id ?? null,
          is_error: parsed?.is_error ?? false,
          service_tier: parsed?.service_tier ?? null,
        });
      },
    );
}
