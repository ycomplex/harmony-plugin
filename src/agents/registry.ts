// B-1075: the agent-adapter registry — registry id → adapter. B-1077 routes legs by this id.

import type { AgentAdapter } from './contract.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';

const ADAPTERS: ReadonlyMap<string, AgentAdapter> = new Map([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexAdapter.id, codexAdapter], // B-1076
]);

export const DEFAULT_ADAPTER_ID = claudeCodeAdapter.id;

export function listAdapterIds(): string[] {
  return [...ADAPTERS.keys()];
}

export function hasAdapter(id: string): boolean {
  return ADAPTERS.has(id);
}

/** Look an adapter up by registry id. Throws, naming the registered ids, on an unknown id. */
export function getAdapter(id: string): AgentAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unknown agent adapter '${id}' — registered: ${listAdapterIds().join(', ')}`);
  }
  return adapter;
}
