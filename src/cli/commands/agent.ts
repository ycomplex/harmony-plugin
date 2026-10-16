// B-1077: `harmony agent ...` — the node accessor container/provision.sh launches every leg through.
//
// provision.sh used to hand-assemble `claude --plugin-dir … -p … [--resume …] … --output-format json
// [--model …]` at each launch site and only WARN when two credentials were set. It now asks this
// command instead, so the agent-adapter registry (src/agents/registry.ts) — selected per run by
// run_config.agent.adapter, absent = claude-code — decides the binary, the argv and the credential
// verdict. Same "node accessor, never a hand-duplicated bash copy" precedent as `harmony model ...`
// (src/cli/commands/model.ts), and, like it, NOT wired through runCommand: each subcommand owns its
// exit code because bash branches on it.
//
// Fully offline: the adapter comes from this leg's FROZEN launch env (HARMONY_RUN_CONFIG_PATH /
// HARMONY_RUN_CONFIG_JSON — the same payload the daemon checked at fire time, see
// src/daemon/agent-eligibility.ts), never a live board re-read: the adapter a leg launches with must
// be the one the daemon admitted.
//
// Exit contract (every subcommand): 0 = go, stdout carries the answer; 1 = refuse, stdout EMPTY and
// a "Refusing to start: …" line on stderr.

import { Command } from 'commander';
import { getRunConfig, type RunConfig } from '../../config/run-config.js';
import {
  REFUSAL_PREFIX,
  buildLaunchCommand,
  checkLaunchCredentials,
  encodeNulArgv,
  resolveLaunchAdapter,
} from '../../agents/launch-routing.js';
import type { AgentAdapter } from '../../agents/contract.js';

/** This leg's run_config from its launch env. An UNPARSEABLE payload degrades to `{}` with a loud
 *  warning — the same best-effort treatment provision.sh gives `session_resume` on the identical
 *  bytes (B-718), and the payload the daemon admitted was well-formed by construction (it is
 *  JSON.stringify of the conduction row). A well-formed payload naming a bad adapter is NOT
 *  degraded: resolveLaunchAdapter refuses it. */
function launchRunConfig(): RunConfig {
  try {
    return getRunConfig();
  } catch (err) {
    console.error(
      `harmony agent: WARNING — failed to parse this leg's run_config (${err instanceof Error ? err.message : String(err)}); ` +
        'resolving the agent adapter as if run_config were {} (claude-code)',
    );
    return {};
  }
}

function refuse(message: string): never {
  console.error(`${REFUSAL_PREFIX} ${message}`);
  process.exit(1);
}

function adapterOrRefuse(): AgentAdapter {
  const resolved = resolveLaunchAdapter(launchRunConfig());
  if (!resolved.ok) refuse(`${resolved.error} (run_config.agent.adapter; no fallback to the default adapter).`);
  return resolved.adapter;
}

interface ArgvOpts {
  pluginDir: string;
  prompt: string;
  resume?: string;
  model?: string;
}

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command('agent')
    .description(
      'B-1077 agent-adapter routing accessor — the ONE place container/provision.sh learns which ' +
        'agent runtime this leg runs and how to launch it (run_config.agent.adapter → ' +
        'src/agents/registry.ts). Never hand-assemble the launch in bash.',
    );

  agent
    .command('resolve')
    .description("Print this leg's adapter id (exit 0), or refuse (exit 1) on a malformed/unregistered adapter.")
    .action(() => {
      process.stdout.write(`${adapterOrRefuse().id}\n`);
    });

  agent
    .command('binary')
    .description("Print the adapter's executable name (for provision.sh's presence probe).")
    .action(() => {
      process.stdout.write(`${adapterOrRefuse().launch.binary}\n`);
    });

  agent
    .command('check-credentials')
    .description(
      "Run the adapter's credential check against this process's env. Exit 0 printing the " +
        'credential mode; exit 1 with "Refusing to start: …" when two credentials are set at once ' +
        '(B-934: a config error, never a precedence rule) or none is. Empty values count as unset.',
    )
    .action(() => {
      const adapter = adapterOrRefuse();
      const verdict = checkLaunchCredentials(adapter, process.env);
      if (!verdict.ok) refuse(`${adapter.displayName}: ${verdict.error}`);
      process.stdout.write(`${verdict.credential}\n`);
    });

  agent
    .command('argv')
    .description(
      "Print the full launch command (the adapter's binary, then its headless argv) as " +
        "NUL-terminated elements. Read in bash with: while IFS= read -r -d '' t; do a+=(\"$t\"); done. " +
        'Upstream flags (CLAUDE_HEADLESS_FLAGS) go after `--`, already word-split.',
    )
    .requiredOption('--plugin-dir <dir>', 'The plugin checkout the agent loads')
    .requiredOption('--prompt <prompt>', 'The headless prompt')
    .option('--resume <session-id>', 'Resume this session id')
    .option('--model <alias>', 'Launch on this model alias')
    .argument('[extra...]', 'Upstream flags, passed through in order (put them after `--`)')
    .action((extra: string[], opts: ArgvOpts) => {
      const adapter = adapterOrRefuse();
      const argv = buildLaunchCommand(adapter, {
        pluginDir: opts.pluginDir,
        prompt: opts.prompt,
        resumeSessionId: opts.resume || undefined,
        model: opts.model || undefined,
        extraFlags: extra ?? [],
      });
      process.stdout.write(encodeNulArgv(argv));
    });
}
