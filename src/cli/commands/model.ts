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
  catalogEntriesForAgent,
  DEFAULT_AGENT_ADAPTER,
  entryModelId,
  entryProvider,
  findModelEntry,
  normalizeModelId,
  getAgentAdapter,
  getModelForGate,
  getPinnedDefaultModel,
  resolveDeploymentProfile,
  isAllowedModelAlias,
  readModelHandoffRequest,
  resolveModelCatalog,
  resolveRunConfigFromConduction,
  writeModelHandoffRequest,
  type RunConfig,
} from '../../config/run-config.js';
import { resolveGatePhase } from '../../daemon/gate-phase.js';
import { fetchCatalogPrice } from '../../tools/catalog-pricing.js';
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
    .option('--agent <id>', 'Agent runtime whose catalog rows to match (B-1147)', DEFAULT_AGENT_ADAPTER)
    .action(async (alias: string, opts: { agent?: string }) => {
      const client = await getCatalogClient();
      const ok = await isAllowedModelAlias(alias, client, opts.agent ?? DEFAULT_AGENT_ADAPTER);
      console.log(ok ? 'true' : 'false');
      process.exit(ok ? 0 : 1);
    });

  model
    .command('normalize')
    .description('Print the runtime model id for a catalog alias or id; pass through unchanged if the live catalog is unavailable or the name is unknown.')
    .argument('<model>')
    .option('--agent <id>', 'Agent runtime whose active rows to match', DEFAULT_AGENT_ADAPTER)
    .option('--offered-only', 'Print nothing for an unoffered name when the live catalog is reachable')
    .action(async (model: string, opts: { agent?: string; offeredOnly?: boolean }) => {
      // B-1178: an explicit name — an inactive offer still normalizes and still counts as offered (AC7).
      const explicit = { includeInactive: true };
      const { entries, source } = await resolveModelCatalog(await getCatalogClient(), explicit);
      console.log(source === 'live' && opts.offeredOnly && !findModelEntry(model, entries, opts.agent, explicit)
        ? '' : source === 'live' ? normalizeModelId(model, entries, opts.agent, explicit) : model);
    });

  model
    .command('context-budget')
    .description(
      "Print <alias>'s resumable-session-size budget in bytes, from the live catalog (falling " +
        'back to the embedded degrade-only list, then a conservative default for an alias absent ' +
        'from either — always exits 0).',
    )
    .argument('<alias>')
    .option('--agent <id>', "Agent runtime whose catalog row to weigh against (B-1148); omitted = the pre-B-1148 alias match")
    .action(async (alias: string, opts: { agent?: string }) => {
      const client = await getCatalogClient();
      console.log(String(await getModelContextBudgetBytes(alias, client, opts.agent)));
    });

  model
    .command('pinned-default')
    .description(
      "B-1148: print the live catalog's pinned default model for --agent on THIS deployment's " +
        'profile (derived from HARMONY_SUPABASE_URL), falling back to the embedded per-adapter pin; ' +
        'an empty line when nothing is pinned. Always exits 0 — container/provision.sh uses it when a ' +
        'non-Claude leg got no usable HARMONY_MODEL.',
    )
    .option('--agent <id>', 'Agent runtime whose pinned row to read', DEFAULT_AGENT_ADAPTER)
    .action(async (opts: { agent?: string }) => {
      const agent = opts.agent ?? DEFAULT_AGENT_ADAPTER;
      try {
        const client = await getCatalogClient();
        const { entries } = await resolveModelCatalog(client);
        console.log(getPinnedDefaultModel(agent, resolveDeploymentProfile(process.env), entries) ?? '');
      } catch (err: any) {
        console.error(`harmony model pinned-default: WARNING — ${err?.message ?? String(err)}; printing nothing`);
        console.log('');
      }
    });

  model
    .command('list-aliases')
    .description(
      'Print every currently-active model-catalog alias, one per line — live when the catalog is ' +
        'reachable, else the embedded degrade-only list. Always exits 0. Consumed by ' +
        "skills/harmony-conduct/SKILL.md step 1d's park-on-refusal comment (B-881), so a human " +
        'reviewing the park sees exactly which aliases were selectable at the time.',
    )
    .option('--agent <id>', 'Agent runtime whose model ids to list (B-1147)', DEFAULT_AGENT_ADAPTER)
    .action(async (opts: { agent?: string }) => {
      const client = await getCatalogClient();
      const { entries } = await resolveModelCatalog(client);
      for (const entry of catalogEntriesForAgent(entries, opts.agent ?? DEFAULT_AGENT_ADAPTER)) {
        console.log(entryModelId(entry));
      }
    });

  model
    .command('list')
    .description(
      'B-1346: print every active catalog offer of --agent, one tab-separated line each: model id, ' +
        'runtime, provider, and input / cached-input / output USD per million tokens ("not captured" ' +
        'when the catalog has no price). A header line comes first. Always exits 0.',
    )
    .option('--agent <id>', 'Agent runtime whose offers to list', DEFAULT_AGENT_ADAPTER)
    .action(async (opts: { agent?: string }) => {
      const agent = opts.agent ?? DEFAULT_AGENT_ADAPTER;
      const client = await getCatalogClient();
      const { entries } = await resolveModelCatalog(client);
      const price = (v: unknown): string =>
        typeof v === 'number' && Number.isFinite(v) ? String(v) : 'not captured';
      console.log(['model', 'runtime', 'provider', 'input_usd_per_mtok', 'cached_input_usd_per_mtok', 'output_usd_per_mtok'].join('\t'));
      for (const entry of catalogEntriesForAgent(entries, agent)) {
        const modelId = entryModelId(entry);
        const p = await fetchCatalogPrice(client, modelId, agent);
        console.log(
          [modelId, agent, entryProvider(entry), price(p?.input_per_mtok), price(p?.cached_input_per_mtok), price(p?.output_per_mtok)].join('\t'),
        );
      }
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
    .option(
      '--agent <id>',
      "Agent runtime to resolve for (B-1147); defaults to the run_config's own agent.adapter, else claude-code",
    )
    .action(async (workflowState: string, opts: { activity?: string; agent?: string }) => {
      let runConfig = await resolveGateRunConfig();
      if (opts.agent) runConfig = { ...runConfig, agent: { adapter: opts.agent } };
      const gate = resolveGatePhase(workflowState, opts.activity ?? null);
      const selection = getAgentAdapter(runConfig);
      const adapter = selection.ok ? selection.adapter : DEFAULT_AGENT_ADAPTER;
      // B-1147: Claude resolution stays catalog-free (byte-for-byte B-772); another runtime's
      // pinned tier is read from the live catalog's pinned_default_profiles.
      if (adapter === DEFAULT_AGENT_ADAPTER) {
        console.log(getModelForGate(runConfig, gate));
        return;
      }
      const client = await getCatalogClient();
      const { entries } = await resolveModelCatalog(client);
      console.log(getModelForGate(runConfig, gate, process.env, entries));
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
    .option('--agent <id>', 'Agent runtime the alias must belong to (B-1147)', DEFAULT_AGENT_ADAPTER)
    .action(async (alias: string, opts: { agent?: string }) => {
      const agent = opts.agent ?? DEFAULT_AGENT_ADAPTER;
      const client = await getCatalogClient();
      const { entries } = await resolveModelCatalog(client);
      const entry = findModelEntry(alias, entries, agent);
      if (!entry) {
        console.error(
          `harmony model request-switch: '${alias}' is not in the live model catalog for runtime '${agent}' (${catalogEntriesForAgent(
            entries,
            agent,
          )
            .map((entry) => entryModelId(entry))
            .join(', ')})`,
        );
        process.exit(1);
        return;
      }
      writeModelHandoffRequest(entryModelId(entry));
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
