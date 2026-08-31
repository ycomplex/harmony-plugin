// B-772 round 2: `harmony model ...` — the node subprocess accessor bash (container/provision.sh,
// container/entrypoint.sh) uses to read the model-switch loop's TypeScript-owned tables (the alias
// allowlist, the per-model context-budget table) and to read/write/clear the handoff-file contract
// — all three live in src/config/run-config.ts, ONE source of truth. Mirrors the EXISTING
// `harmony config get` precedent (src/cli/commands/config.ts, invoked from bash exactly this way at
// container/cloud-worker-launch.sh:70) — a node accessor, never a hand-duplicated bash copy of
// either table (the addendum's explicit ask; see the ticket's own WorkflowPrimaryAction.tsx
// cautionary tale).
//
// Deliberately NOT wired through runCommand (src/cli/run-command.ts): every subcommand here
// reads/writes a local file or a pure in-memory table, and none of them wants runCommand's
// error-to-exit-1 shape. Same reasoning as config.ts's own header note.
//
// B-892 exception: `resolve-gate` now takes an OPTIONAL, best-effort trip through
// getAuthenticatedContext to re-read `conductions.run_config` from the DB at the gate boundary (the
// launch env is a frozen snapshot that a mid-conduction operator edit can never reach). It is still
// not wired through runCommand, and login is still not REQUIRED — every failure on that path
// (no conduction id, no login, no network, an unreadable row) falls back to the launch env, so the
// subcommand's never-throws contract is unchanged. Every OTHER subcommand remains offline.

import { Command } from 'commander';
import {
  clearModelHandoffRequest,
  getConductionId,
  getModelContextBudgetBytes,
  getRunConfig,
  getModelForGate,
  isAllowedModelAlias,
  MODEL_ALIAS_ALLOWLIST,
  readModelHandoffRequest,
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

export function registerModelCommands(program: Command): void {
  const model = program
    .command('model')
    .description(
      'B-772 model-switch-loop node accessor — the ONE place bash (container/provision.sh, ' +
        'container/entrypoint.sh) reads the alias allowlist / context-budget table / handoff-file ' +
        'contract src/config/run-config.ts owns. Never hand-duplicate these tables in bash.',
    );

  model
    .command('check-alias')
    .description(
      'Print "true" and exit 0 if <alias> is in the canonical allowlist; print "false" and exit 1 otherwise.',
    )
    .argument('<alias>')
    .action((alias: string) => {
      const ok = isAllowedModelAlias(alias);
      console.log(ok ? 'true' : 'false');
      process.exit(ok ? 0 : 1);
    });

  model
    .command('context-budget')
    .description(
      "Print <alias>'s resumable-session-size budget in bytes (falls back to a conservative " +
        'default for an alias absent from the table — always exits 0).',
    )
    .argument('<alias>')
    .action((alias: string) => {
      console.log(String(getModelContextBudgetBytes(alias)));
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
        'Validates <alias> against the allowlist FIRST — refuses (exit 1, no file written) on an ' +
        'unrecognized alias.',
    )
    .argument('<alias>')
    .action((alias: string) => {
      if (!isAllowedModelAlias(alias)) {
        console.error(
          `harmony model request-switch: '${alias}' is not in the allowlist (${MODEL_ALIAS_ALLOWLIST.join(', ')})`,
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
