import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import type { Command } from 'commander';
import { runningPluginRoot } from '../../config/plugin-source.js';

const safeId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine((v) => Number.isSafeInteger(Number(v)));
const permissions = { actions: 'read', checks: 'read', contents: 'write', deployments: 'read', metadata: 'read', pull_requests: 'write', statuses: 'read' };
const resultSchema = z.object({
  app_id: safeId.nullable(), installation_id: safeId.nullable(),
  permissions: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), z.enum(['read', 'write', 'admin'])).refine((v) => Object.keys(v).length <= 100),
  events: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)).max(100),
  repository_selection: z.enum(['all', 'selected']).nullable(),
  repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(100_000),
  expected_permissions: z.boolean(), expected_events: z.boolean(), app_identity_matches: z.boolean(), repositories_complete: z.boolean(), ok: z.boolean(),
  error: z.object({ stage: z.enum(['input', 'key', 'installation', 'mint', 'repositories', 'expectations']), code: z.enum(['invalid-input', 'unsafe-origin', 'request-failed', 'invalid-response', 'identity-mismatch', 'suspended-or-unknown', 'invalid-permissions', 'invalid-events', 'invalid-selection', 'invalid-token-response', 'invalid-page', 'inconsistent-total', 'invalid-or-repeated-repository', 'incomplete-repositories', 'page-limit', 'check-failed', 'unexpected-grants-or-events']), http_status: z.number().int().min(100).max(599).optional() }).strict().optional(),
}).strict();
export interface AppCheckOptions { appId: string; installationId: string; privateKeyPath: string }
export type ChildRunner = (file: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
const runChild: ChildRunner = (file, args) => new Promise((resolve) => {
  // No ambient tokens, inline keys, alternate API host or Node preload options enter the child.
  execFile(process.execPath, [file, ...args], { shell: false, env: {}, timeout: 120_000, maxBuffer: 24 * 1024 * 1024 }, (err, stdout) => {
    resolve({ stdout, exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
  });
});
export async function runAppCheck(opts: AppCheckOptions, deps: { root?: string | null; run?: ChildRunner } = {}) {
  const failure = { exitCode: 1, data: { ok: false, error: { stage: 'wrapper', code: 'check-unavailable' } }, lines: ['OK: no', 'Error: wrapper/check-unavailable'] };
  if (!safeId.safeParse(opts.appId).success || !safeId.safeParse(opts.installationId).success || !opts.privateKeyPath || opts.privateKeyPath.includes('\0')) {
    return { ...failure, data: { ok: false, error: { stage: 'input', code: 'invalid-input' } }, lines: ['OK: no', 'Error: input/invalid-input'] };
  }
  try {
    const root = deps.root === undefined ? runningPluginRoot() : deps.root;
    if (!root) return failure;
    const child = await (deps.run ?? runChild)(join(root, 'scripts/check-app-installation.mjs'), ['--app-id', opts.appId, '--installation-id', opts.installationId, '--private-key-path', opts.privateKeyPath]);
    if (child.stdout.length > 24 * 1024 * 1024 || ![0, 1].includes(child.exitCode)) return failure;
    const data = resultSchema.parse(JSON.parse(child.stdout));
    if (data.app_id !== opts.appId || data.installation_id !== opts.installationId) return failure;
    // A child's success must agree with its evidence and process exit, never merely its `ok` field.
    const expected = JSON.stringify(Object.fromEntries(Object.entries(data.permissions).sort())) === JSON.stringify(permissions);
    if (data.ok !== (data.expected_permissions && data.expected_events && data.app_identity_matches && data.repositories_complete) || data.expected_permissions !== expected || data.expected_events !== (data.repository_selection !== null && data.events.length === 0) || child.exitCode !== (data.ok ? 0 : 1)) return failure;
    const yes = (v: boolean) => v ? 'yes' : 'no';
    const lines = [`App: ${data.app_id}`, `Installation: ${data.installation_id}`, `Permissions: ${Object.entries(data.permissions).map(([k, v]) => `${k}=${v}`).join(', ')}`, `Events: ${JSON.stringify(data.events)}`, `Repository selection: ${data.repository_selection ?? 'unknown'}`, 'Repositories:', ...data.repositories.map((r) => `  ${r}`), `Expected permissions: ${yes(data.expected_permissions)}`, `Expected events: ${yes(data.expected_events)}`, `App identity matches: ${yes(data.app_identity_matches)}`, `Repositories complete: ${yes(data.repositories_complete)}`, `OK: ${yes(data.ok)}`];
    if (data.error) lines.push(`Error: ${data.error.stage}/${data.error.code}${data.error.http_status ? ` (HTTP ${data.error.http_status})` : ''}`);
    return { exitCode: data.ok ? 0 : 1, data, lines };
  } catch { return failure; }
}
export function registerAppCheck(program: Command, conductor: Command): void {
  conductor.command('check-app').description('Check an explicit GitHub App installation without printing credentials')
    .requiredOption('--app-id <id>', 'GitHub App id')
    .requiredOption('--installation-id <id>', 'Installation id')
    .requiredOption('--private-key-path <path>', 'Path to the App private key (never printed)')
    .action(async (opts: AppCheckOptions) => {
      const result = await runAppCheck(opts);
      if (program.opts().json) console.log(JSON.stringify(result.data, null, 2));
      else for (const line of result.lines) console.log(line);
      process.exitCode = result.exitCode;
    });
}
