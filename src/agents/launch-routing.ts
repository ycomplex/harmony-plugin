// B-1077: the worker side of the agent-adapter routing seam.
//
// container/provision.sh no longer composes the agent command itself: it asks `harmony agent ...`
// (src/cli/commands/agent.ts), which resolves the run's adapter from run_config.agent.adapter
// (src/config/run-config.ts's getAgentAdapter — absent = claude-code) through the registry and lets
// THAT adapter decide the binary, the argv and the credential verdict. Everything here is pure: no
// spawning, no env/file reads beyond the arguments passed in.
//
// The daemon's half is src/daemon/agent-eligibility.ts (fire-time: registered AND allowed on the
// profile, else park). This file is the worker's re-check of the same run_config: an unknown or
// malformed adapter is refused here too, never launched as claude-code.

import type { AgentAdapter, CredentialResolution, HeadlessInput } from './contract.js';
import { getAdapter } from './registry.js';
import { getAgentAdapter, type RunConfig } from '../config/run-config.js';

/** Every refusal a worker prints starts with this, so an operator greps one phrase (it matches
 *  provision.sh's existing B-383 "Refusing to start:" line). */
export const REFUSAL_PREFIX = 'Refusing to start:';

export type LaunchAdapterResolution = { ok: true; adapter: AgentAdapter } | { ok: false; error: string };

/** Resolve the adapter a run_config selects. Malformed selection or an unregistered id ⇒ `ok:false`
 *  with the registry's own message (which names the registered adapters). Never throws. */
export function resolveLaunchAdapter(runConfig: RunConfig): LaunchAdapterResolution {
  const selection = getAgentAdapter(runConfig);
  if (!selection.ok) return { ok: false, error: selection.error };
  try {
    return { ok: true, adapter: getAdapter(selection.adapter) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The full launch command — the adapter's binary followed by its headless argv. */
export function buildLaunchCommand(adapter: AgentAdapter, input: HeadlessInput): string[] {
  return [adapter.launch.binary, ...adapter.headless.buildArgv(input)];
}

/** The adapter's credential verdict for this environment (two at once, or none, is `ok:false`). */
export function checkLaunchCredentials(
  adapter: AgentAdapter,
  env: Readonly<Record<string, string | undefined>>,
): CredentialResolution {
  return adapter.auth.resolveCredential(env);
}

/** NUL-terminate each argv element — the only encoding bash can read back losslessly (a prompt can
 *  carry spaces, quotes and newlines; it can never carry a NUL). Read with
 *  `while IFS= read -r -d '' tok; do argv+=("$tok"); done`. */
export function encodeNulArgv(argv: readonly string[]): string {
  for (const a of argv) {
    if (a.includes('\0')) throw new Error('argv element contains a NUL byte');
  }
  return argv.map((a) => `${a}\0`).join('');
}

/** Inverse of encodeNulArgv (tests and diagnostics). */
export function decodeNulArgv(encoded: string): string[] {
  if (encoded === '') return [];
  const parts = encoded.split('\0');
  parts.pop(); // the trailing terminator
  return parts;
}
