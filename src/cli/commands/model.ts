// B-772 round 2: `harmony model ...` — the node subprocess accessor bash (container/provision.sh,
// container/entrypoint.sh) uses to read the model-switch loop's TypeScript-owned tables (the alias
// allowlist, the per-model context-budget table) and to read/write/clear the handoff-file contract
// — all three live in src/config/run-config.ts, ONE source of truth. Mirrors the EXISTING
// `harmony config get` precedent (src/cli/commands/config.ts, invoked from bash exactly this way at
// container/cloud-worker-launch.sh:70) — a node accessor, never a hand-duplicated bash copy of
// either table (the addendum's explicit ask; see the ticket's own WorkflowPrimaryAction.tsx
// cautionary tale).
//
// Deliberately NOT wired through runCommand/getAuthenticatedContext (src/cli/run-command.ts): every
// subcommand here reads/writes a local file or a pure in-memory table — no Harmony API call, no
// login required. Same reasoning as config.ts's own header note.

import { Command } from 'commander';
import {
  clearModelHandoffRequest,
  getModelContextBudgetBytes,
  getRunConfig,
  getModelForGate,
  isAllowedModelAlias,
  MODEL_ALIAS_ALLOWLIST,
  readModelHandoffRequest,
  writeModelHandoffRequest,
} from '../../config/run-config.js';
import { resolveGatePhase } from '../../daemon/gate-phase.js';

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
      "Print the model getModelForGate resolves for <workflow-state> (this worker's own " +
        'HARMONY_RUN_CONFIG_PATH/HARMONY_RUN_CONFIG_JSON env, exactly as the daemon reads it) — the ' +
        "accessor skills/harmony-conduct/SKILL.md step 1d uses to compute THIS gate's model. Never " +
        "throws: a run_config parse failure falls back to the empty run_config (getModelForGate's " +
        'own pinned-default tier still resolves something explicit) rather than crashing the ' +
        "agent's turn.",
    )
    .argument('<workflow-state>')
    .option('--activity <workflow-activity>', 'The ticket\'s workflow_activity, if known')
    .action((workflowState: string, opts: { activity?: string }) => {
      let runConfig;
      try {
        runConfig = getRunConfig();
      } catch (err: any) {
        console.error(`harmony model resolve-gate: WARNING — failed to read run_config (${err.message}); falling back to no run_config`);
        runConfig = {};
      }
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
