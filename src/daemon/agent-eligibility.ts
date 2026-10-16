// B-1077: may this run's legs launch on this daemon's launch profile? The daemon's half of the
// agent-adapter routing seam, checked in fireLaunch BEFORE a leg is counted or a worker launched.
//
// Deliberately an id lookup and a list comparison, nothing more. The worker picks the adapter and
// launches whatever command that adapter builds (container/provision.sh → `harmony agent argv`); the
// daemon never builds a runtime command — src/agents/daemon-runtime-guard.test.ts enforces that over
// every src/daemon file, this one included.
//
// Refused (⇒ the scheduler parks the ticket with `reason` as the comment, no worker launched):
//   1. a malformed run_config.agent value — never a silent fallback to claude-code;
//   2. an adapter id the registry does not know (the registry's own message names the registered ids);
//   3. an adapter not in the profile's `agents` list (absent list = ["claude-code"] only);
//   4. a NON-default adapter on a launch template with no {run_config_json} placeholder: the worker
//      would never see run_config.agent, resolve the default, and silently run claude-code instead.

import { getAgentAdapter, type RunConfig } from '../config/run-config.js';
import { DEFAULT_ADAPTER_ID, listAdapterIds } from '../agents/registry.js';

/** A profile that declares no `agents` list allows exactly this. */
export const DEFAULT_PROFILE_AGENTS: readonly string[] = [DEFAULT_ADAPTER_ID];

export interface AgentEligibilityInput {
  runConfig: RunConfig;
  /** The active launch profile's `agents` list; undefined = DEFAULT_PROFILE_AGENTS. */
  profileAgents?: readonly string[];
  /** Does the active launch template carry {run_config_json}, i.e. will the worker see run_config? */
  templateDeliversRunConfig: boolean;
  /** The registered adapter ids; defaults to the real registry (injectable for tests). */
  registeredAdapters?: readonly string[];
}

export type AgentEligibility =
  | { eligible: true; adapter: string }
  | { eligible: false; adapter: string | null; reason: string };

function context(registered: readonly string[], profileAgents: readonly string[]): string {
  return `Registered agent adapters: ${registered.join(', ')}. This launch profile allows: ${profileAgents.join(', ')}.`;
}

/** The registry's own unknown-id message (src/agents/registry.ts getAdapter), for the same list. */
export function unknownAdapterMessage(id: string, registered: readonly string[]): string {
  return `Unknown agent adapter '${id}' — registered: ${registered.join(', ')}`;
}

export function evaluateAgentEligibility(input: AgentEligibilityInput): AgentEligibility {
  const profileAgents = input.profileAgents ?? DEFAULT_PROFILE_AGENTS;
  const registered = input.registeredAdapters ?? listAdapterIds();
  const ctx = context(registered, profileAgents);
  const selection = getAgentAdapter(input.runConfig);
  if (!selection.ok) {
    return { eligible: false, adapter: null, reason: `${selection.error}. ${ctx}` };
  }
  const id = selection.adapter;
  if (!registered.includes(id)) {
    return { eligible: false, adapter: id, reason: `${unknownAdapterMessage(id, registered)}. ${ctx}` };
  }
  if (!profileAgents.includes(id)) {
    return {
      eligible: false,
      adapter: id,
      reason: `Agent adapter '${id}' is not allowed on this launch profile. ${ctx}`,
    };
  }
  if (id !== DEFAULT_ADAPTER_ID && !input.templateDeliversRunConfig) {
    return {
      eligible: false,
      adapter: id,
      reason:
        `Agent adapter '${id}' needs run_config to reach the worker, but the active launch template has no ` +
        `{run_config_json} placeholder — the worker would resolve the default adapter instead. ${ctx}`,
    };
  }
  return { eligible: true, adapter: id };
}

/** The ticket comment a refusal parks with. */
export function formatAgentIneligibleComment(result: Extract<AgentEligibility, { eligible: false }>): string {
  return (
    `harmony daemon refused to launch this leg — agent adapter not eligible on this launch profile.\n\n` +
    `${result.reason}\n\n` +
    `Fix: set run_config.agent.adapter to an allowed adapter (or remove it to use the default, ` +
    `${DEFAULT_ADAPTER_ID}), or add the adapter to the profile's \`agents\` list once it is registered, ` +
    `then re-conduct.`
  );
}
