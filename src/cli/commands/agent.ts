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
//
// B-1178: `provider` is the one subcommand that reads the board — the live model catalog, best-effort, to
// say which provider serves an EXPLICITLY named model (inactive rows included). The launchers and
// provision.sh call it; `render-provider` and `argv --provider` then stay offline. Its exit codes: 0 = the
// model is known (stdout carries the answer); 1 = unknown model or no catalog (the caller treats the leg as
// an OpenAI one, exactly as before B-1178); 2 = the row names a provider this build does not know (refuse).

import { Command } from 'commander';
import {
  getRunConfig,
  entryModelId,
  entryProvider,
  findModelEntry,
  resolveModelCatalog,
  type ModelCatalogEntry,
  type RunConfig,
} from '../../config/run-config.js';
import {
  REFUSAL_PREFIX,
  buildLaunchCommand,
  checkLaunchCredentials,
  encodeNulArgv,
  resolveLaunchAdapter,
} from '../../agents/launch-routing.js';
import { CAPABILITIES, type AgentAdapter, type Capability } from '../../agents/contract.js';
import {
  CODEX_AUTH_FILE_ENV,
  CODEX_THREAD_FILE_NAME,
  buildCodexThreadRecord,
  parseCodexThreadId,
  parseCodexThreadRecord,
  resolveCodexCredential,
} from '../../agents/codex.js';
import { isDefaultCodexProvider, lookupCodexProvider, type CodexProvider } from '../../agents/codex-providers.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MissingHookScriptError, provisionCodex, renderCodexProviderConfig } from '../../agents/codex-provision.js';
import { getAuthenticatedContext } from '../auth.js';
import { addComment } from '../../tools/comments.js';
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

/** B-1149: a missing hook script is posted on the leg's ticket (TICKET) before the worker exits 1, so
 *  the board says why no codex ran. Best-effort: no ticket / no login / a failed write is logged and
 *  the refusal still happens. */
async function postMissingHookComment(err: MissingHookScriptError): Promise<void> {
  const ticket = process.env.TICKET;
  if (!ticket) {
    console.error('harmony agent render: WARNING — no TICKET in env; the missing-hook-script comment was not posted');
    return;
  }
  try {
    const ctx = await getAuthenticatedContext();
    await addComment(ctx.client, ctx.projectId, ctx.userId, {
      task_id: ticket,
      content: `Codex leg did not start — ${err.message}. Restore the script(s) in the plugin checkout (or re-provision the worker) and the next leg will launch.`,
    });
  } catch (e) {
    console.error(
      `harmony agent render: WARNING — could not post the missing-hook-script comment (${e instanceof Error ? e.message : String(e)})`,
    );
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
  provider?: string;
}

/** B-1178: what `harmony agent provider` reports for one catalog row. Names only — never a value. */
export interface OfferProvider {
  agent: string;
  model: string;
  provider: string;
  /** Null for the runtime's default provider (no key: the login cache / subscription). */
  env_key: string | null;
  secret: string | null;
  base_url: string | null;
  context_window_tokens: number | null;
}

/** B-1178: the provider facts for a resolved catalog row. `ok: false` when the row names a provider this
 *  build's registry does not know (the caller refuses; never a silent default). */
export function describeOfferProvider(
  entry: ModelCatalogEntry,
  agent: string,
): { ok: true; value: OfferProvider } | { ok: false; error: string } {
  const provider = entryProvider(entry);
  const window = typeof entry.context_window_tokens === 'number' ? entry.context_window_tokens : null;
  const base = { agent, model: entryModelId(entry), provider, context_window_tokens: window };
  if (agent !== 'codex' || isDefaultCodexProvider(provider)) {
    return { ok: true, value: { ...base, env_key: null, secret: null, base_url: null } };
  }
  const found = lookupCodexProvider(provider);
  if (!found.ok) return { ok: false, error: `model '${base.model}': ${found.error}` };
  return { ok: true, value: { ...base, env_key: found.provider.envKey, secret: found.provider.secretName, base_url: found.provider.baseUrl } };
}

const PROVIDER_FIELDS = ['provider', 'env-key', 'secret', 'context-window', 'base-url'] as const;
type ProviderField = (typeof PROVIDER_FIELDS)[number];

function providerField(v: OfferProvider, field: ProviderField): string {
  switch (field) {
    case 'provider':
      return v.provider;
    case 'env-key':
      return v.env_key ?? '';
    case 'secret':
      return v.secret ?? '';
    case 'context-window':
      return v.context_window_tokens === null ? '' : String(v.context_window_tokens);
    case 'base-url':
      return v.base_url ?? '';
  }
}

/** B-1178: best-effort authenticated client for the catalog read (null = the embedded fallback). */
async function catalogClient() {
  try {
    return (await getAuthenticatedContext()).client;
  } catch {
    return null;
  }
}

/** B-1178: a non-default provider name from a CLI flag, or null for the default; refuses an unknown one. */
function providerOrRefuse(name: string | undefined): CodexProvider | null {
  if (isDefaultCodexProvider(name)) return null;
  const found = lookupCodexProvider(name as string);
  if (!found.ok) refuse(found.error);
  return found.provider;
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
    .action(async (opts: { pluginDir: string; workspace: string; codexHome?: string; extraRepo?: string[] }) => {
      const adapter = adapterOrRefuse();
      if (adapter.id !== 'codex') {
        console.error(`harmony agent render: ${adapter.displayName} needs no rendered runtime config.`);
        return;
      }
      const authFile = process.env[CODEX_AUTH_FILE_ENV];
      // B-1178: a leg on a provider's API key has no login cache to install; any other missing path refuses
      // exactly as before.
      const providerKeyLeg = !authFile && (() => {
        const v = resolveCodexCredential(process.env);
        return v.ok && v.credential === 'api-key';
      })();
      if (!authFile && !providerKeyLeg) refuse(`${CODEX_AUTH_FILE_ENV} is not set.`);
      try {
        const r = provisionCodex({
          pluginDir: opts.pluginDir,
          workspaceDir: opts.workspace,
          codexHome: opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'),
          authFile: authFile || undefined,
          extraRepoPaths: opts.extraRepo,
        });
        // Paths and counts only — never the credential file's content.
        console.error(
          `harmony agent render: codex config ${r.configPath}; AGENTS.md ${r.agentsMdPath} (${r.agentsMdBytes} bytes from ` +
            `${r.sources.join(', ')}); skills ${r.skillsLink}; ` +
            (r.authInstalledAt ? `login cache installed at ${r.authInstalledAt}` : 'no login cache (a provider API-key leg)'),
        );
      } catch (err) {
        if (err instanceof MissingHookScriptError) await postMissingHookComment(err);
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
    .option('--provider <name>', "B-1178: the offer's model provider (from `agent provider`); a non-default one adds `-c model_provider=<name>`")
    .argument('[extra...]', 'Upstream flags, passed through in order (put them after `--`)')
    .action((extra: string[], opts: ArgvOpts) => {
      const adapter = adapterOrRefuse();
      const provider = adapter.id === 'codex' ? providerOrRefuse(opts.provider || undefined) : null;
      const argv = buildLaunchCommand(adapter, {
        pluginDir: opts.pluginDir,
        prompt: opts.prompt,
        resumeSessionId: opts.resume || undefined,
        model: opts.model || undefined,
        ...(provider ? { modelProvider: provider.name } : {}),
        extraFlags: extra ?? [],
      });
      process.stdout.write(encodeNulArgv(argv));
    });

  // --- B-1178: the offer's model provider ---------------------------------------------------------------

  agent
    .command('provider')
    .description(
      "B-1178: print the model provider that serves --model (the live catalog row, matched by its alias or model " +
        "id; an inactive row still answers — the run named it). `openai` / `anthropic` when the row names none. " +
        '--field prints one fact for the launchers; --json prints all of them (names only, never a value). Exit 1 ' +
        'on an unknown model (or no reachable catalog), 2 on a provider this build does not know.',
    )
    .requiredOption('--model <model>', 'The model the leg runs on (catalog alias or model id)')
    .option('--agent <id>', 'Agent runtime whose catalog rows to match', 'codex')
    .option('--field <field>', `One of: ${PROVIDER_FIELDS.join(', ')}`, 'provider')
    .option('--json', 'Print every fact as one JSON object')
    .action(async (opts: { model: string; agent: string; field: string; json?: boolean }, cmd: Command) => {
      // B-1348: the root program also declares --json (src/cli/index.ts), and commander hands the flag to
      // the root in either argv position, so this subcommand's own opts.json stays undefined. Read both.
      const json = Boolean(opts.json || cmd.optsWithGlobals().json);
      if (!(PROVIDER_FIELDS as readonly string[]).includes(opts.field)) {
        console.error(`harmony agent provider: unknown --field '${opts.field}' — expected one of: ${PROVIDER_FIELDS.join(', ')}`);
        process.exit(1);
      }
      const explicit = { includeInactive: true };
      const { entries, source } = await resolveModelCatalog(await catalogClient(), explicit);
      const entry = findModelEntry(opts.model, entries, opts.agent, explicit);
      if (!entry) {
        console.error(
          `harmony agent provider: model '${opts.model}' is not in the ${source === 'live' ? 'live' : 'embedded fallback'} model catalog for runtime '${opts.agent}'`,
        );
        process.exit(1);
      }
      const described = describeOfferProvider(entry as ModelCatalogEntry, opts.agent);
      if (!described.ok) {
        console.error(`harmony agent provider: ${described.error}`);
        process.exit(2);
      }
      const v = (described as { ok: true; value: OfferProvider }).value;
      process.stdout.write(json ? `${JSON.stringify(v)}\n` : `${providerField(v, opts.field as ProviderField)}\n`);
    });

  agent
    .command('render-provider')
    .description(
      "B-1178: re-render the Codex config.toml for the leg's offer — the [model_providers.<name>] table and the " +
        "model's context window for a non-OpenAI provider; for openai the plain config. Checks the credential for " +
        'that provider first: its key must be mounted and the login cache must not be (names only). Exit 1 with ' +
        '"Refusing to start: …" on any problem.',
    )
    .requiredOption('--plugin-dir <dir>', 'The plugin checkout')
    .requiredOption('--provider <name>', "The offer's provider (from `agent provider`)")
    .option('--context-window <tokens>', "The offer's context window in tokens (from `agent provider --field context-window`)")
    .option('--codex-home <dir>', 'The worker CODEX_HOME (default: $CODEX_HOME or ~/.codex)')
    .action((opts: { pluginDir: string; provider: string; contextWindow?: string; codexHome?: string }) => {
      const adapter = adapterOrRefuse();
      if (adapter.id !== 'codex') refuse(`${adapter.displayName} has no model-provider config.`);
      const provider = providerOrRefuse(opts.provider);
      const verdict = resolveCodexCredential(process.env, provider ? provider.name : 'openai');
      if (!verdict.ok) refuse(`Codex: ${verdict.error}`);
      let window: number | null = null;
      if (opts.contextWindow !== undefined && opts.contextWindow !== '') {
        if (!/^[1-9][0-9]*$/.test(opts.contextWindow)) refuse(`--context-window must be a positive integer, got '${opts.contextWindow}'.`);
        window = Number(opts.contextWindow);
      }
      try {
        const path = renderCodexProviderConfig({
          pluginDir: opts.pluginDir,
          codexHome: opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'),
          provider,
          contextWindowTokens: window,
        });
        console.error(
          `harmony agent render-provider: codex config ${path} (provider ${provider ? provider.name : 'openai'}` +
            `${provider && window !== null ? `, model_context_window ${window}` : ''})`,
        );
      } catch (err) {
        refuse(`Codex provider config failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // --- B-1148: the Codex thread file (resume + in-place model switch) ---------------------------------

  agent
    .command('thread-id')
    .description(
      'Print the Codex thread id parsed from a codex `--json` stdout capture (its thread.started event) ' +
        'and exit 0; print nothing and exit 1 when the capture has none or is unreadable.',
    )
    .argument('<stdout-file>')
    .action((file: string) => {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        process.exit(1);
      }
      const id = parseCodexThreadId(text);
      if (!id) process.exit(1);
      process.stdout.write(`${id}\n`);
    });

  agent
    .command('write-thread')
    .description(
      `Parse the thread id from a codex stdout capture and write ${CODEX_THREAD_FILE_NAME} ({agent:"codex", ` +
        'thread_id, model, time}) into --dir; prints the id. Exit 1, leaving any existing file untouched, ' +
        'when the capture carries no thread id.',
    )
    .requiredOption('--dir <dir>', "The conduction's Codex sessions folder")
    .requiredOption('--stdout-file <file>', 'The codex invocation\'s stdout capture')
    .option('--model <model>', 'The model the invocation ran on')
    .action((opts: { dir: string; stdoutFile: string; model?: string }) => {
      let text = '';
      try {
        text = readFileSync(opts.stdoutFile, 'utf8');
      } catch {
        process.exit(1);
      }
      const id = parseCodexThreadId(text);
      if (!id) process.exit(1);
      try {
        mkdirSync(opts.dir, { recursive: true });
        const target = join(opts.dir, CODEX_THREAD_FILE_NAME);
        const tmp = `${target}.tmp-${process.pid}`;
        writeFileSync(tmp, `${JSON.stringify(buildCodexThreadRecord(id, opts.model))}\n`);
        renameSync(tmp, target);
      } catch (err) {
        console.error(`harmony agent write-thread: WARNING — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      process.stdout.write(`${id}\n`);
    });

  agent
    .command('read-thread')
    .description(
      `Print the thread id from a ${CODEX_THREAD_FILE_NAME} file and exit 0 — ONLY when the file names ` +
        'agent "codex" and a well-formed id; otherwise print nothing and exit 1.',
    )
    .argument('<thread-file>')
    .action((file: string) => {
      if (!existsSync(file)) process.exit(1);
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        process.exit(1);
      }
      const rec = parseCodexThreadRecord(text);
      if (!rec) process.exit(1);
      process.stdout.write(`${rec.thread_id}\n`);
    });
}
