// B-772 round 2 / B-881: `harmony model ...` — the node subprocess accessor bash
// (container/provision.sh, container/entrypoint.sh) uses to read the model-switch loop's
// TypeScript-owned data (the live model catalog, the handoff-file contract) — all of it lives in
// src/config/run-config.ts, ONE source of truth. Mirrors the EXISTING `harmony config get`
// precedent (src/cli/commands/config.ts, invoked from bash exactly this way at
// container/cloud-worker-launch.sh:70) — a node accessor, never a hand-duplicated bash copy.
//
// Deliberately NOT wired through runCommand (src/cli/run-command.ts): every subcommand here
// reads/writes a local file or does its own best-effort catalog read, and none of them wants
// runCommand's error-to-exit-1 shape. Same reasoning as config.ts's own header note.
//
// B-892 exception (extended by B-881 to the catalog-reading subcommands too): `resolve-gate`,
// `check-alias`, `context-budget`, `request-switch`, and `list-aliases` each take an OPTIONAL,
// best-effort trip through getAuthenticatedContext (`resolve-gate` to re-read
// `conductions.run_config`; the other four to read the live `model_catalog` table). None of these
// trips is REQUIRED — every failure on that path (no login, no network, an unreadable/missing row
// or table) degrades to that accessor's own documented fallback (the frozen launch env for
// resolve-gate; MODEL_CATALOG_FALLBACK for the catalog reads), so every subcommand's never-throws
// contract is unchanged. `running-model`, `read-handoff`, and `clear-handoff` remain fully offline.

import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  clearModelHandoffRequest,
  getConductionId,
  getModelContextBudgetBytes,
  getRunConfig,
  getModelForGate,
  isAllowedModelAlias,
  readModelHandoffRequest,
  resolveModelCatalog,
  resolveRunConfigFromConduction,
  writeModelHandoffRequest,
  type RunConfig,
} from '../../config/run-config.js';
import { resolveGatePhase } from '../../daemon/gate-phase.js';
import { getAuthenticatedContext } from '../auth.js';

/** B-892: the run_config `resolve-gate` should resolve THIS gate's model from — the live
 *  `conductions.run_config` row when it is readable, else this leg's frozen launch env, else the
 *  empty config (getModelForGate's pinned-default tier still resolves something explicit).
 *
 *  Never throws, by construction: every failure mode degrades one tier down and logs a WARNING to
 *  STDERR only, because provision.sh's switch loop captures this command's STDOUT as the wanted
 *  model. A leg that cannot reach the board must still resolve a model and keep running — the
 *  launch env is the same payload the row held at fire time, so the fallback is only stale by
 *  whatever the operator edited mid-run. */
async function resolveGateRunConfig(): Promise<RunConfig> {
  const conductionId = getConductionId();
  if (conductionId) {
    try {
      const { client } = await getAuthenticatedContext();
      const fromRow = await resolveRunConfigFromConduction(client, conductionId);
      if (fromRow) return fromRow;
      console.error(
        `harmony model resolve-gate: WARNING — conduction ${conductionId}'s run_config was unreadable from the board; falling back to this leg's launch env`,
      );
    } catch (err: any) {
      console.error(
        `harmony model resolve-gate: WARNING — could not reach the board to re-read run_config (${err?.message ?? String(err)}); falling back to this leg's launch env`,
      );
    }
  }

  try {
    return getRunConfig();
  } catch (err: any) {
    console.error(
      `harmony model resolve-gate: WARNING — failed to read run_config (${err?.message ?? String(err)}); falling back to no run_config`,
    );
    return {};
  }
}

/** B-881: best-effort authenticated client for a live `model_catalog` read, or `null` when this
 *  process has no login/config to authenticate with. NOT itself a WARNING-worthy event — an
 *  unauthenticated environment running `harmony model ...` offline is an ordinary, expected shape
 *  (mirrors resolve-gate's own "no conductionId -> no attempt" branch above): `isAllowedModelAlias`
 *  / `getModelContextBudgetBytes` / `resolveModelCatalog` (src/config/run-config.ts) already treat a
 *  `null` client as a silent degrade to MODEL_CATALOG_FALLBACK, and log their OWN warning only when
 *  an actual live attempt against a real client fails (the table-absent / network-failure case this
 *  ticket's tolerance requirement is about). */
async function getCatalogClient(): Promise<SupabaseClient | null> {
  try {
    const { client } = await getAuthenticatedContext();
    return client;
  } catch {
    return null;
  }
}

export function registerModelCommands(program: Command): void {
  const model = program
    .command('model')
    .description(
      'B-881 live-model-catalog node accessor — the ONE place bash (container/provision.sh, ' +
        'container/entrypoint.sh) reads the model catalog / context-budget data / handoff-file ' +
        'contract src/config/run-config.ts owns. Never hand-duplicate this data in bash.',
    );

  model
    .command('check-alias')
    .description(
      'Print "true" and exit 0 if <alias> is in the live model catalog (falling back to the ' +
        'embedded degrade-only list when the catalog is unreachable); print "false" and exit 1 otherwise.',
    )
    .argument('<alias>')
    .action(async (alias: string) => {
      const client = await getCatalogClient();
      const ok = await isAllowedModelAlias(alias, client);
      console.log(ok ? 'true' : 'false');
      process.exit(ok ? 0 : 1);
    });

  model
    .command('context-budget')
    .description(
      "Print <alias>'s resumable-session-size budget in bytes, from the live catalog (falling " +
        'back to the embedded degrade-only list, then a conservative default for an alias absent ' +
        'from either — always exits 0).',
    )
    .argument('<alias>')
    .action(async (alias: string) => {
      const client = await getCatalogClient();
      console.log(String(await getModelContextBudgetBytes(alias, client)));
    });

  model
    .command('list-aliases')
    .description(
      'Print every currently-active model-catalog alias, one per line — live when the catalog is ' +
        'reachable, else the embedded degrade-only list. Always exits 0. Consumed by ' +
        "skills/harmony-conduct/SKILL.md step 1d's park-on-refusal comment (B-881), so a human " +
        'reviewing the park sees exactly which aliases were selectable at the time.',
    )
    .action(async () => {
      const client = await getCatalogClient();
      const { entries } = await resolveModelCatalog(client);
      for (const entry of entries) console.log(entry.alias);
    });

  model
    .command('running-model')
    .description(
      "Print this process's own HARMONY_MODEL env var (the model the currently-running `claude` " +
        "invocation was actually launched with, set by container/provision.sh's switch loop, " +
        're-exported fresh on every re-invocation), or an empty line when unset (this deployment ' +
        'profile does not render {model} at all, round-1\'s opt-out path). Always exits 0 -- an ' +
        'empty result is a legitimate answer, never an error.',
    )
    .action(() => {
      console.log(process.env.HARMONY_MODEL ?? '');
    });

  model
    .command('resolve-gate')
    .description(
      'Print the model getModelForGate resolves for <workflow-state> — the accessor ' +
        "skills/harmony-conduct/SKILL.md step 1d uses to compute THIS gate's model. B-892: reads " +
        "the LIVE conductions.run_config row (this worker's HARMONY_CONDUCTION_ID) so a " +
        'mid-conduction operator edit lands at the gate boundary, falling back to this leg\'s ' +
        'frozen HARMONY_RUN_CONFIG_PATH/HARMONY_RUN_CONFIG_JSON launch env when the row is ' +
        "unreachable/unreadable or there is no conduction. Never throws: every failure degrades a " +
        "tier (getModelForGate's own pinned-default tier still resolves something explicit) rather " +
        "than crashing the agent's turn. NOTE this is the WANTED model — `running-model` (what this " +
        'process actually launched with) is the other half of step 1d\'s comparison and is ' +
        'deliberately env-only.',
    )
    .argument('<workflow-state>')
    .option('--activity <workflow-activity>', 'The ticket\'s workflow_activity, if known')
    .action(async (workflowState: string, opts: { activity?: string }) => {
      const runConfig = await resolveGateRunConfig();
      const gate = resolveGatePhase(workflowState, opts.activity ?? null);
      console.log(getModelForGate(runConfig, gate));
    });

  model
    .command('request-switch')
    .description(
      'Write a model-switch handoff request for container/provision.sh\'s switch loop to pick up. ' +
        'Validates <alias> against the live model catalog FIRST — refuses (exit 1, no file ' +
        'written) on an alias that is not active in the catalog (nor in the embedded fallback list ' +
        'when the catalog itself is unreachable).',
    )
    .argument('<alias>')
    .action(async (alias: string) => {
      const client = await getCatalogClient();
      const ok = await isAllowedModelAlias(alias, client);
      if (!ok) {
        const { entries } = await resolveModelCatalog(client);
        console.error(
          `harmony model request-switch: '${alias}' is not in the live model catalog (${entries
            .map((entry) => entry.alias)
            .join(', ')})`,
        );
        process.exit(1);
        return;
      }
      writeModelHandoffRequest(alias);
    });

  model
    .command('read-handoff')
    .description(
      'Print the pending handoff request\'s alias to stdout and exit 0, or print nothing and exit 1 ' +
        'when none is pending. Does NOT delete the file — pair with `clear-handoff` after consuming.',
    )
    .action(() => {
      const req = readModelHandoffRequest();
      if (!req) {
        process.exit(1);
        return;
      }
      console.log(req.requested_model);
    });

  model
    .command('clear-handoff')
    .description('Delete the pending handoff request file, if any. Idempotent — always exits 0.')
    .action(() => {
      clearModelHandoffRequest();
    });
}
