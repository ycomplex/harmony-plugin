// B-1147: conduction-creation runtime/model guard. A run's models are resolved within ONE agent
// runtime (run_config.agent.adapter, absent => claude-code): a Codex run cannot run a Claude alias
// and vice versa. Both conduction-creation entry points (the create_conduction MCP tool and
// `harmony conduct`) call assertRunConfigRuntime AFTER the project-defaults fill, so a project
// default runtime is checked exactly like an explicit one. Kept out of run-config.ts so that
// widely-imported module does not pull the adapter registry into every consumer.

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasAdapter, listAdapterIds } from '../agents/registry.js';
import {
  catalogEntriesForAgent,
  entryModelId,
  findModelEntry,
  getAgentAdapter,
  resolveModelCatalog,
  type RunConfig,
} from './run-config.js';
import { getWorkspaceModelPolicy } from './model-policy.js';

/** The run default and every per-gate model a run_config names (duplicates kept). */
function requestedModels(runConfig: RunConfig): string[] {
  const requested: string[] = [];
  if (runConfig.model?.default) requested.push(runConfig.model.default);
  for (const value of Object.values(runConfig.model?.per_gate ?? {})) {
    if (typeof value === 'string' && value) requested.push(value);
  }
  return requested;
}

/** Refuses (throws) when `runConfig` names an unregistered agent runtime, a malformed agent, or a
 *  model (run default or any per-gate override) that is not in the catalog for that runtime.
 *  No run_config, or one naming no model, passes untouched. */
export async function assertRunConfigRuntime(
  client: SupabaseClient | null | undefined,
  runConfig: RunConfig | undefined,
): Promise<void> {
  if (!runConfig) return;
  const selection = getAgentAdapter(runConfig);
  if (!selection.ok) throw new Error(selection.error);
  const adapter = selection.adapter;
  if (!hasAdapter(adapter)) {
    throw new Error(
      `Unknown agent runtime '${adapter}' — available runtimes: ${listAdapterIds().join(', ')}`,
    );
  }

  const requested = requestedModels(runConfig);
  if (requested.length === 0) return;

  // B-1178: the run NAMES these models, so an inactive offer is still accepted (AC7); the "available"
  // list in the refusal stays active-only, like every other list.
  const { entries } = await resolveModelCatalog(client, { includeInactive: true });
  const available = catalogEntriesForAgent(entries, adapter)
    .filter((entry) => entry.active)
    .map((entry) => entryModelId(entry));
  const bad = [...new Set(requested.filter((model) => !findModelEntry(model, entries, adapter, { includeInactive: true })))];
  if (bad.length > 0) {
    throw new Error(
      `Model${bad.length > 1 ? 's' : ''} ${bad.map((m) => `'${m}'`).join(', ')} not available on runtime '${adapter}' — ` +
        `available models for '${adapter}': ${available.length > 0 ? available.join(', ') : '(none in the catalog)'}`,
    );
  }
}

/** `model` with a leading `<agent>:` catalog prefix removed (`codex:gpt-6.1-sol` -> `gpt-6.1-sol`). */
function stripAgentPrefix(model: string, agent: string): string {
  const trimmed = model.trim();
  const prefix = `${agent}:`;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed.slice(prefix.length) : trimmed;
}

/** B-1346: refuses (throws) when the owning workspace has a non-empty model policy and `runConfig`
 *  names a model (run default or any per-gate override) outside it. A requested model is allowed
 *  when it and some policy entry resolve to the SAME catalog row of the run's runtime (inactive rows
 *  included — the run names them explicitly), or, failing that, when the two strings are equal once a
 *  leading `<agent>:` prefix is stripped. Call it AFTER assertRunConfigRuntime. No run_config, no
 *  model, or an empty policy passes untouched. */
export async function assertRunConfigPolicy(
  client: SupabaseClient | null | undefined,
  projectId: string,
  runConfig: RunConfig | undefined,
): Promise<void> {
  if (!runConfig) return;
  const requested = requestedModels(runConfig);
  if (requested.length === 0) return;
  const { allowed } = await getWorkspaceModelPolicy(client, projectId);
  if (allowed.length === 0) return;

  const selection = getAgentAdapter(runConfig);
  if (!selection.ok) throw new Error(selection.error);
  const adapter = selection.adapter;
  const { entries } = await resolveModelCatalog(client, { includeInactive: true });
  const resolve = (model: string) => findModelEntry(model, entries, adapter, { includeInactive: true });
  const allowedRows = new Set(allowed.map(resolve).filter((entry) => entry !== undefined));
  const allowedRaw = new Set(allowed.map((entry) => stripAgentPrefix(entry, adapter)));

  const isAllowed = (model: string): boolean => {
    const row = resolve(model);
    if (row && allowedRows.has(row)) return true;
    return allowedRaw.has(stripAgentPrefix(model, adapter));
  };
  const bad = [...new Set(requested.filter((model) => !isAllowed(model)))];
  if (bad.length > 0) {
    throw new Error(
      `Model${bad.length > 1 ? 's' : ''} ${bad.map((m) => `'${m}'`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} ` +
        `not allowed by this workspace's model policy — allowed: ${allowed.join(', ')}`,
    );
  }
}
