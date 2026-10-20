// B-1183: the mint script reads the base env and repos from the MERGED config (`harmony config get env` /
// `repos`), so a host with .harmony/conductor.json + the host file and no deployment.json still launches
// legs with its env. Two guards the founder required:
//   (1) a legacy host (deployment.json + daemon.env, no project file) gets a leg env file BYTE-IDENTICAL to
//       what origin/main's script wrote — pinned below against bytes captured from that script;
//   (2) a `config get` that fails, times out, or prints nothing never yields a silently smaller env.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeploymentConfig, resolveConfigPath } from './config/deployment-config.js';

import {
  composeEnvFile,
  resolveBaseContent,
  runConfigGet,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../scripts/mint-installation-token.mjs';

/** Today's Mac mini deployment.json shape: env incl. HARMONY_TARGET and CLAUDE_HEADLESS_FLAGS in the file's own
 *  (not the schema's) key order, a key the loader strips, repos[] with meta_repo_role (keys again in the file's
 *  order, plus one the loader strips), and both profiles. */
const LEGACY = {
  worker_image: 'harmony-build-env',
  env: {
    CLAUDE_HEADLESS_FLAGS: '--output-format stream-json --verbose',
    HARMONY_PLUGIN_POSTURE: 'ack:staging',
    HARMONY_TARGET: 'prod',
    HARMONY_API_TOKEN: 'tok-legacy',
    GIT_TOKEN: 'ghp_stale_founder_pat',
    GIT_USER_NAME: 'Harmony Worker',
    CUSTOM_PASSTHROUGH: 'kept',
    WEB_REF: 'main',
  },
  repos: [
    { path: '/workspace/workspace', url: 'https://github.com/ycomplex/harmony-workspace.git', meta_repo_role: true },
    { is_plugin: true, path: '/workspace/workspace/plugin', url: 'https://github.com/ycomplex/harmony-plugin.git', ref: 'staging', note: 'ignored by the loader' },
  ],
  profiles: {
    gke: { launch: 'l', reap: 'r', probe: 'p', maxConcurrentWorkers: 2 },
    cloud: { launch: 'l', reap: 'r', probe: 'p', gcloud_project: 'proj' },
  },
  launcher: { plugin_dir: '/opt/harmony-plugin' },
};

/** Captured by running origin/main's resolveBaseContent + composeEnvFile (token ghs_minted) over LEGACY. */
const BEFORE_BYTES =
  'CLAUDE_HEADLESS_FLAGS=--output-format stream-json --verbose\n' +
  'HARMONY_PLUGIN_POSTURE=ack:staging\n' +
  'HARMONY_TARGET=prod\n' +
  'HARMONY_API_TOKEN=tok-legacy\n' +
  'GIT_USER_NAME=Harmony Worker\n' +
  'CUSTOM_PASSTHROUGH=kept\n' +
  'WEB_REF=main\n' +
  'HARMONY_REPOS_JSON=W3sicGF0aCI6Ii93b3Jrc3BhY2Uvd29ya3NwYWNlIiwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL3ljb21wbGV4L2hhcm1vbnktd29ya3NwYWNlLmdpdCIsIm1ldGFfcmVwb19yb2xlIjp0cnVlfSx7ImlzX3BsdWdpbiI6dHJ1ZSwicGF0aCI6Ii93b3Jrc3BhY2Uvd29ya3NwYWNlL3BsdWdpbiIsInVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS95Y29tcGxleC9oYXJtb255LXBsdWdpbi5naXQiLCJyZWYiOiJzdGFnaW5nIiwibm90ZSI6Imlnbm9yZWQgYnkgdGhlIGxvYWRlciJ9XQ==\n' +
  'GIT_TOKEN=ghs_minted\n';

const SILENT = { log: () => {} };

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

/** `harmony config get <key>` as src/cli/commands/config.ts implements it, over the real loader. */
function realConfigGet(configPath: string, home: string) {
  return (key: string) => {
    const dc = loadDeploymentConfig({ configPath, env: { HARMONY_HOME: home }, warn: () => {} });
    const v = dc === null ? undefined : resolveConfigPath(dc, key);
    if (v === undefined) return { status: 'unset' };
    return { status: 'ok', stdout: typeof v === 'string' ? v : JSON.stringify(v) };
  };
}

describe('legacy host: leg env file is byte-identical to origin/main', () => {
  const leg = (profiles: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-legacy-'));
    const configPath = writeJson(dir, 'deployment.json', { ...LEGACY, profiles });
    // An empty HARMONY_HOME: no project file, no host file, no snapshot — only the legacy files.
    const baseContent = resolveBaseContent({ configPath, env: { HARMONY_HOME: dir }, cliImpl: realConfigGet(configPath, dir), ...SILENT });
    return composeEnvFile({ baseContent, token: 'ghs_minted' });
  };

  it.each([
    ['gke', { gke: LEGACY.profiles.gke }],
    ['cloud', { cloud: LEGACY.profiles.cloud }],
    ['both profiles', LEGACY.profiles],
  ])('profile %s', (_name, profiles) => {
    expect(leg(profiles)).toBe(BEFORE_BYTES);
  });

  it('is identical to the file-only path (the CLI unavailable) too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-legacy-'));
    const configPath = writeJson(dir, 'deployment.json', LEGACY);
    const baseContent = resolveBaseContent({ configPath, env: {}, cliImpl: () => ({ status: 'failed', unavailable: true, reason: 'x' }), ...SILENT });
    expect(composeEnvFile({ baseContent, token: 'ghs_minted' })).toBe(BEFORE_BYTES);
  });
});

describe('a files-only host (no deployment.json): env and repos come from the merged config', () => {
  it('uses the merged env and repos, with the --base file lines underneath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-files-'));
    const base = join(dir, 'container.env');
    writeFileSync(base, 'HARMONY_API_TOKEN=from-base\nHARMONY_TARGET=staging\n');
    const repos = [{ url: 'https://github.com/o/w.git', path: '/workspace/w', meta_repo_role: true }];
    const out = resolveBaseContent({
      base,
      configPath: join(dir, 'absent.json'),
      env: {},
      cliImpl: (key: string) =>
        key === 'env'
          ? { status: 'ok', stdout: JSON.stringify({ HARMONY_PLUGIN_POSTURE: 'prod', HARMONY_TARGET: 'prod', CLAUDE_HEADLESS_FLAGS: '--verbose' }) }
          : { status: 'ok', stdout: JSON.stringify(repos) },
      ...SILENT,
    });
    expect(out.startsWith('HARMONY_API_TOKEN=from-base\nHARMONY_TARGET=prod\nHARMONY_PLUGIN_POSTURE=prod\nCLAUDE_HEADLESS_FLAGS=--verbose\n')).toBe(true);
    const line = out.split('\n').find((l: string) => l.startsWith('HARMONY_REPOS_JSON='));
    expect(JSON.parse(Buffer.from(line.slice('HARMONY_REPOS_JSON='.length), 'base64').toString())).toEqual(repos);
  });

  it('merged values win over deployment.json, and its other keys stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-over-'));
    const configPath = writeJson(dir, 'deployment.json', { env: { HARMONY_TARGET: 'prod', GIT_USER_NAME: 'n' } });
    const out = resolveBaseContent({
      configPath,
      env: {},
      cliImpl: (key: string) => (key === 'env' ? { status: 'ok', stdout: JSON.stringify({ HARMONY_TARGET: 'staging', GIT_USER_NAME: 'n' }) } : { status: 'unset' }),
      ...SILENT,
    });
    expect(out).toBe('HARMONY_TARGET=staging\nGIT_USER_NAME=n\n');
  });

  it('repos from the merged config replace a differing deployment.json list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-repos-'));
    const configPath = writeJson(dir, 'deployment.json', { repos: [{ url: 'old', path: '/old' }] });
    const merged = [{ url: 'new', path: '/new' }];
    const out = resolveBaseContent({
      configPath,
      env: {},
      cliImpl: (key: string) => (key === 'repos' ? { status: 'ok', stdout: JSON.stringify(merged) } : { status: 'unset' }),
      ...SILENT,
    });
    const line = out.split('\n').find((l: string) => l.startsWith('HARMONY_REPOS_JSON='));
    expect(JSON.parse(Buffer.from(line.slice('HARMONY_REPOS_JSON='.length), 'base64').toString())).toEqual(merged);
  });
});

describe('a broken `config get` never launches a leg with a silently smaller env', () => {
  const pluginDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-plugin-'));
    mkdirSync(join(dir, 'dist', 'bin'), { recursive: true });
    return dir;
  };
  const stub = (dir: string, body: string) => writeFileSync(join(dir, 'dist', 'bin', 'harmony.js'), body);
  const run = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-broken-'));
    const configPath = writeJson(dir, 'deployment.json', LEGACY);
    const logs: string[] = [];
    // The REAL runConfigGet (default cliImpl) against a stub CLI script.
    const baseContent = resolveBaseContent({ configPath, env, log: (m: string) => logs.push(m) });
    return { out: composeEnvFile({ baseContent, token: 'ghs_minted' }), logs };
  };

  it('non-zero exit: falls back to deployment.json, logs once', () => {
    const d = pluginDir();
    stub(d, 'console.error("boom"); process.exit(2);');
    const { out, logs } = run({ HARMONY_PLUGIN_DIR: d });
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('exited 2');
  });

  it('exit 1 with an error that is not the clean "not set": still a failure', () => {
    const d = pluginDir();
    stub(d, 'console.error("harmony config get: deployment config at x failed validation"); process.exit(1);');
    const { out, logs } = run({ HARMONY_PLUGIN_DIR: d });
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
  });

  it('timeout: falls back to deployment.json, logs once', () => {
    const d = pluginDir();
    stub(d, 'setTimeout(() => {}, 30000);');
    const { out, logs } = run({ HARMONY_PLUGIN_DIR: d, HARMONY_CONFIG_GET_TIMEOUT_MS: '300' });
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('timed out after 300ms');
  });

  it('empty output: falls back to deployment.json, logs once', () => {
    const d = pluginDir();
    stub(d, 'process.exit(0);');
    const { out, logs } = run({ HARMONY_PLUGIN_DIR: d });
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('printed nothing');
  });

  it('an empty merged env while deployment.json has one: falls back, logs once', () => {
    const d = pluginDir();
    stub(d, 'console.log("{}");');
    const { out, logs } = run({ HARMONY_PLUGIN_DIR: d });
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('came back empty');
  });

  it.each([
    ['HARMONY_PLUGIN_DIR unset', () => ({})],
    ['dist/bin/harmony.js missing', () => ({ HARMONY_PLUGIN_DIR: mkdtempSync(join(tmpdir(), 'b1183-nocli-')) })],
  ])('CLI missing (%s): falls back to deployment.json, logs once', (_n, env) => {
    const { out, logs } = run(env());
    expect(out).toBe(BEFORE_BYTES);
    expect(logs).toHaveLength(1);
  });

  it('a working CLI logs nothing', () => {
    const d = pluginDir();
    stub(d, `if (process.argv[4] === 'env') console.log(JSON.stringify({ HARMONY_TARGET: 'prod' })); else console.log('[]');`);
    const dir = mkdtempSync(join(tmpdir(), 'b1183-ok-'));
    const configPath = writeJson(dir, 'deployment.json', { env: { HARMONY_TARGET: 'prod' } });
    const logs: string[] = [];
    const out = resolveBaseContent({ configPath, env: { HARMONY_PLUGIN_DIR: d }, log: (m: string) => logs.push(m) });
    expect(out).toBe('HARMONY_TARGET=prod\n');
    expect(logs).toEqual([]);
  });

  it('runConfigGet classifies the clean "not set" exit as unset, not a failure', () => {
    const d = pluginDir();
    stub(d, `console.error("harmony config get: 'repos' is not set in /x/deployment.json"); process.exit(1);`);
    expect(runConfigGet('repos', { env: { HARMONY_PLUGIN_DIR: d } })).toEqual({ status: 'unset' });
  });

  it('a host with no deployment.json and an unavailable CLI is silent and keeps the --base behaviour', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1183-legacyenv-'));
    const base = join(dir, 'c.env');
    writeFileSync(base, 'HARMONY_API_TOKEN=legacy\n');
    const logs: string[] = [];
    const out = resolveBaseContent({ base, configPath: join(dir, 'none.json'), env: {}, log: (m: string) => logs.push(m) });
    expect(out).toBe('HARMONY_API_TOKEN=legacy\n');
    expect(logs).toEqual([]);
  });
});
