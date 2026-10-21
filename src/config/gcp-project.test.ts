// B-1186: one resolver for gcp.project. The logs command used to miss a project nested in .harmony/conductor.json;
// the lifecycle guard and pre-flight used to invent 'harmony-conductor'.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConductorConfigSync } from './conductor-config.js';
import { GCP_PROJECT_UNSET, resolveGcpProject } from './gcp-project.js';
import { defaultLogsDeps, runConductorLogs } from '../cli/commands/conductor-logs.js';

const project = (extra: object = {}) => JSON.stringify({ version: 1, channel: 'staging', profile: 'gke', gcp: { project: 'nested-proj' }, ...extra });
const fsOf = (files: Record<string, string>) => ({
  existsSync: (p: string) => p in files,
  readFileSync: (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p]!;
  },
});

describe('resolveGcpProject', () => {
  it('finds gcp.project nested in the project file even when the rest of the config is incomplete', () => {
    const files = { '/p.json': project() }; // no host file: plugin_dir / github_app / cluster are all missing
    const env = { HARMONY_HOME: '/h', HARMONY_CONDUCTOR_PROJECT_FILE: '/p.json' };
    // the root cause of the `conductor logs` miss: the strict loader throws for those unrelated keys ...
    expect(() => loadConductorConfigSync({ env, ...fsOf(files), warn: () => {} })).toThrow();
    // ... and the old caller swallowed the throw. The resolver reads the value anyway.
    expect(resolveGcpProject({ env, ...fsOf(files), cwd: '/nowhere' })).toBe('nested-proj');
  });

  it('finds it in the .harmony/conductor.json of the current directory', () => {
    const files = { '/repo/.harmony/conductor.json': project() };
    expect(resolveGcpProject({ env: { HARMONY_HOME: '/h' }, ...fsOf(files), cwd: '/repo' })).toBe('nested-proj');
  });

  it('a host-file gcp.project overrides the project file; an exported CLOUDSDK_CORE_PROJECT wins over both', () => {
    const files = { '/p.json': project(), '/h/conductor-host.json': JSON.stringify({ version: 1, gcp: { project: 'host-proj' } }) };
    const env = { HARMONY_HOME: '/h', HARMONY_CONDUCTOR_PROJECT_FILE: '/p.json' };
    expect(resolveGcpProject({ env, ...fsOf(files), cwd: '/x' })).toBe('host-proj');
    expect(resolveGcpProject({ env: { ...env, CLOUDSDK_CORE_PROJECT: 'exported' }, ...fsOf(files), cwd: '/x' })).toBe('exported');
  });

  it('uses a merged config the caller already evaluated', () => {
    expect(resolveGcpProject({ env: {}, merged: { gcp: { project: 'm' } }, ...fsOf({}), cwd: '/x' })).toBe('m');
  });

  it('returns undefined (no invented default) when nothing names a project', () => {
    expect(resolveGcpProject({ env: { HARMONY_HOME: '/h' }, ...fsOf({}), cwd: '/x' })).toBeUndefined();
    expect(resolveGcpProject({ env: { HARMONY_HOME: '/h' }, ...fsOf({ '/x/.harmony/conductor.json': project({ gcp: undefined }) }), cwd: '/x' })).toBeUndefined();
    expect(resolveGcpProject({ env: { HARMONY_HOME: '/h' }, ...fsOf({ '/x/.harmony/conductor.json': 'not json' }), cwd: '/x' })).toBeUndefined();
  });
});

describe('conductor logs uses the resolver', () => {
  const base = { now: () => 0, existsSync: () => false, readFileSync: () => '' };
  it('passes the nested project to gcloud', async () => {
    const calls: string[][] = [];
    const r = await runConductorLogs(
      { ...base, env: {}, configuredProject: () => resolveGcpProject({ env: { HARMONY_HOME: '/h' }, ...fsOf({ '/r/.harmony/conductor.json': project() }), cwd: '/r' }), runGcloud: async (a) => (calls.push(a), { code: 0, stdout: '[]', stderr: '' }) },
      { since: '1h', source: 'cloud' },
    );
    expect(r.exitCode).toBe(0);
    expect(calls[0]).toContain('--project=nested-proj');
  });

  it('with no project, fails saying where to set it', async () => {
    const r = await runConductorLogs({ ...base, env: {}, configuredProject: () => undefined, runGcloud: async () => ({ code: 0, stdout: '[]', stderr: '' }) }, { since: '1h', source: 'cloud' });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('gcp');
    expect(r.errLines.join('\n')).toContain('.harmony/conductor.json');
    expect(r.errLines.join('\n')).toContain('conductor-host.json');
    expect(GCP_PROJECT_UNSET).toContain('.harmony/conductor.json');
  });

  it('the default deps resolve through the same function', () => {
    expect(typeof defaultLogsDeps().configuredProject).toBe('function');
  });
});

describe('no hard-coded project fallback remains in the conductor commands', () => {
  it.each(['conductor-lifecycle.ts', 'conductor-preflight.ts', 'conductor-logs.ts'])('%s has no || \'harmony-conductor\' fallback', (f) => {
    const text = readFileSync(fileURLToPath(new URL(`../cli/commands/${f}`, import.meta.url)), 'utf8');
    expect(text).not.toMatch(/CLOUDSDK_CORE_PROJECT\s*\|\|\s*'/);
    expect(text).not.toMatch(/project\s*=.*\|\|\s*'harmony-conductor'/);
  });
});
