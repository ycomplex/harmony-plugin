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
import { CAPABILITIES, type AgentAdapter, type Capability } from '../../agents/contract.js';
import { CODEX_AUTH_FILE_ENV } from '../../agents/codex.js';
import { provisionCodex } from '../../agents/codex-provision.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    .command('capability')
    .description(
      "B-1076: print `true` or `false` — whether this leg's adapter declares the capability " +
        `(${CAPABILITIES.join(' | ')}). The skills read this instead of assuming Claude's feature set ` +
        '(e.g. start-work builds in the root thread when `subagents` is false; harmony-conduct skips ' +
        'step 1d when `modelSwitch` is false). Exit 1 on an unknown capability name or adapter.',
    )
    .argument('<name>', 'The capability to ask about')
    .action((name: string) => {
      if (!(CAPABILITIES as readonly string[]).includes(name)) {
        refuse(`unknown capability '${name}' — expected one of: ${CAPABILITIES.join(', ')}.`);
      }
      process.stdout.write(`${adapterOrRefuse().capabilities[name as Capability]}\n`);
    });

  agent
    .command('render')
    .description(
      "B-1076: render the adapter's on-disk runtime config for this leg (container/provision.sh calls it " +
        'before launch). For Codex: the worker CODEX_HOME/config.toml (harmony MCP, required = true), one ' +
        'generated AGENTS.md at the workspace root, the .agents/skills link, and the copy-in of the mounted ' +
        'login cache. Nothing to render for claude-code (it loads the plugin by flag). Never prints the ' +
        'credential file or its content; exit 1 with "Refusing to start: …" on any problem.',
    )
    .requiredOption('--plugin-dir <dir>', 'The plugin checkout')
    .requiredOption('--workspace <dir>', 'The workspace clone the agent is rooted at')
    .option('--codex-home <dir>', 'The worker CODEX_HOME (default: $CODEX_HOME or ~/.codex)')
    .option('--extra-repo <path...>', "Additional repo paths whose CLAUDE.md is appended after the plugin's")
    .action((opts: { pluginDir: string; workspace: string; codexHome?: string; extraRepo?: string[] }) => {
      const adapter = adapterOrRefuse();
      if (adapter.id !== 'codex') {
        console.error(`harmony agent render: ${adapter.displayName} needs no rendered runtime config.`);
        return;
      }
      const authFile = process.env[CODEX_AUTH_FILE_ENV];
      if (!authFile) refuse(`${CODEX_AUTH_FILE_ENV} is not set.`);
      try {
        const r = provisionCodex({
          pluginDir: opts.pluginDir,
          workspaceDir: opts.workspace,
          codexHome: opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'),
          authFile: authFile as string,
          extraRepoPaths: opts.extraRepo,
        });
        // Paths and counts only — never the credential file's content.
        console.error(
          `harmony agent render: codex config ${r.configPath}; AGENTS.md ${r.agentsMdPath} (${r.agentsMdBytes} bytes from ` +
            `${r.sources.join(', ')}); skills ${r.skillsLink}; login cache installed at ${r.authInstalledAt}`,
        );
      } catch (err) {
        refuse(`Codex provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
