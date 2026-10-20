// B-1172: registry helpers the lifecycle cores share (conductor-lifecycle.ts, conductor-kube.ts).

import { join } from 'node:path';
import type { RegistryClient } from '../../daemon/conductor-registry.js';
import type { LifecycleDeps } from './conductor-lifecycle-deps.js';
import type { ConductorSettings } from './conductor-preflight.js';

export const REGISTRY_ABSENT = 'registry not deployed on this project';

export function pluginVersion(deps: LifecycleDeps, pluginDir: string): string {
  try {
    const v = (JSON.parse(deps.readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) as { version?: string }).version;
    return v || 'unknown';
  } catch {
    return 'unknown';
  }
}

export type RegistryHandle = { client: RegistryClient } | { error: string };

export async function openRegistry(deps: LifecycleDeps, s: ConductorSettings): Promise<RegistryHandle> {
  if (!s.env.HARMONY_API_TOKEN) return { error: 'HARMONY_API_TOKEN is not set' };
  try {
    return { client: await deps.registryClient(s.env) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const ageText = (sec: number | null): string => (sec === null ? 'unknown' : `${Math.round(sec)}s ago`);

export async function completeRequest(
  deps: LifecycleDeps,
  s: ConductorSettings | undefined,
  requestId: string,
  result: 'done' | 'failed',
  reason: string | null,
  data: Record<string, unknown>,
): Promise<{ note: string; line: string }> {
  let note: string;
  try {
    const client = await deps.registryClient(s?.env ?? deps.env);
    const r = await client.completeRequest(`restart-cli@${deps.hostname()}`, {
      requestId,
      result,
      reason: reason ? reason.slice(0, 500) : null,
      versionBefore: typeof data.plugin_version_before === 'string' ? data.plugin_version_before : null,
      versionAfter: typeof data.plugin_version_after === 'string' ? data.plugin_version_after : null,
    });
    note = r.kind === 'ok' ? 'ok' : r.kind === 'refused' ? `refused (${r.reason ?? 'no reason'})` : `${r.kind} (${r.detail})`;
  } catch (err) {
    note = `error (${err instanceof Error ? err.message : String(err)})`;
  }
  return { note, line: `Registry request ${requestId} completed as ${result}: ${note}` };
}
