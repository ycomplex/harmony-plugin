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
  getAgentAdapter,
  resolveModelCatalog,
  type RunConfig,
} from './run-config.js';

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

  const requested: string[] = [];
  if (runConfig.model?.default) requested.push(runConfig.model.default);
  for (const value of Object.values(runConfig.model?.per_gate ?? {})) {
    if (typeof value === 'string' && value) requested.push(value);
  }
  if (requested.length === 0) return;

  const { entries } = await resolveModelCatalog(client);
  const available = catalogEntriesForAgent(entries, adapter).map((entry) => entryModelId(entry));
  const bad = [...new Set(requested.filter((model) => !available.includes(model)))];
  if (bad.length > 0) {
    throw new Error(
      `Model${bad.length > 1 ? 's' : ''} ${bad.map((m) => `'${m}'`).join(', ')} not available on runtime '${adapter}' — ` +
        `available models for '${adapter}': ${available.length > 0 ? available.join(', ') : '(none in the catalog)'}`,
    );
  }
}
