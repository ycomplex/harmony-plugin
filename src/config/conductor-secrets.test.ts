// B-1173: the boot-time secrets resolver. The gcloud stub REJECTS UNKNOWN FLAGS (real gcloud does), so a
// made-up flag cannot pass for a real call.

import { describe, expect, it } from 'vitest';
import { ConductorSecretsError, resolveConductorSecrets, type SecretExec } from './conductor-secrets.js';
import { HostFileSchema } from './conductor-config.js';

const HOST = '/h/conductor-host.json';
const SECRET_VALUES: Record<string, string> = {
  'harmony-api-token': 'tok-VALUE-1234\n',
  'harmony-app-key': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  'empty-one': '\n',
};

/** `gcloud secrets versions access latest --secret=<n> --project=<p>` and nothing else. */
function gcloudStub(opts: { fail?: Set<string> } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: SecretExec = async (file, args) => {
    calls.push({ file, args });
    if (file !== 'gcloud') return { code: 127, stdout: '' };
    const [a, b, c, d, ...flags] = args;
    if (a !== 'secrets' || b !== 'versions' || c !== 'access' || d !== 'latest') throw new Error(`stub: unexpected gcloud subcommand ${args.join(' ')}`);
    let secret: string | undefined;
    let project: string | undefined;
    for (const f of flags) {
      if (f.startsWith('--secret=')) secret = f.slice('--secret='.length);
      else if (f.startsWith('--project=')) project = f.slice('--project='.length);
      else throw new Error(`stub: gcloud secrets versions access: unrecognized arguments: ${f}`);
    }
    if (!secret || !project) throw new Error('stub: --secret and --project are required');
    if (opts.fail?.has(secret) || !(secret in SECRET_VALUES)) return { code: 1, stdout: '' };
    return { code: 0, stdout: SECRET_VALUES[secret] };
  };
  return { exec, calls };
}

const host = (over: Record<string, unknown> = {}) => ({
  version: 1,
  gcp: { project: 'proj-1' },
  secrets: { base: 'harmony-worker-base-env', api_token: 'harmony-api-token', github_app_private_key: 'harmony-app-key' },
  ...over,
});
const files = (h: unknown) => (p: string) => {
  if (p !== HOST) throw new Error(`ENOENT ${p}`);
  return JSON.stringify(h);
};
const REMOTE = { HARMONY_CONDUCTOR_REMOTE: '1', HARMONY_CONDUCTOR_HOST_FILE: HOST };

describe('resolveConductorSecrets', () => {
  it('LOCAL mode: an unreadable or invalid host file is a silent no-op (unchanged behaviour, no call)', async () => {
    const g = gcloudStub();
    for (const readFile of [() => { throw new Error('ENOENT'); }, () => 'not json', () => '{"version":2}']) {
      const target: Record<string, string | undefined> = {};
      const r = await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target, exec: g.exec, readFile });
      expect(r).toEqual({ resolved: [], skipped: [] });
      expect(target).toEqual({});
    }
    expect(g.calls).toEqual([]);
  });

  it('LOCAL mode: a secrets block without the two names makes no call and no failure', async () => {
    const g = gcloudStub();
    const r = await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target: {}, exec: g.exec, readFile: files(host({ secrets: { base: 'b', codex_auth: 'c' } })) });
    expect(r.resolved).toEqual([]);
    const none = await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target: {}, exec: g.exec, readFile: files({ version: 1 }) });
    expect(none.resolved).toEqual([]);
    expect(g.calls).toEqual([]);
  });

  it('LOCAL mode with no conductor.env/daemon.env: resolves the named secrets from Secret Manager', async () => {
    const g = gcloudStub();
    const target: Record<string, string | undefined> = {};
    const r = await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST, HARMONY_HOME: '/nonexistent' }, target, exec: g.exec, readFile: files(host()) });
    expect(r.resolved).toEqual(['HARMONY_API_TOKEN', 'HARMONY_APP_PRIVATE_KEY']);
    expect(target.HARMONY_API_TOKEN).toBe('tok-VALUE-1234');
  });

  it('LOCAL mode: only the named key is fetched; a set (or empty-string-unset) env var wins without a call', async () => {
    const g = gcloudStub();
    const target: Record<string, string | undefined> = { HARMONY_API_TOKEN: 'from-env' };
    await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target, exec: g.exec, readFile: files(host({ secrets: { api_token: 'harmony-api-token', github_app_private_key: 'harmony-app-key' } })) });
    expect(g.calls.map((c) => c.args[4])).toEqual(['--secret=harmony-app-key']);
    const g2 = gcloudStub();
    const t2: Record<string, string | undefined> = { HARMONY_API_TOKEN: '' };
    await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target: t2, exec: g2.exec, readFile: files(host({ secrets: { api_token: 'harmony-api-token' } })) });
    expect(t2.HARMONY_API_TOKEN).toBe('tok-VALUE-1234');
  });

  it('LOCAL mode: a failing read or missing gcloud names only the secret NAME', async () => {
    const env = { HARMONY_CONDUCTOR_HOST_FILE: HOST };
    const a = await resolveConductorSecrets({ env, target: {}, exec: gcloudStub({ fail: new Set(['harmony-api-token']) }).exec, readFile: files(host()) }).catch((e: unknown) => e);
    expect((a as Error).message).toContain('"harmony-api-token"');
    await expect(resolveConductorSecrets({ env, target: {}, exec: async () => ({ code: 127, stdout: '' }), readFile: files(host()) })).rejects.toThrow(/gcloud is not installed/);
  });

  it('is a no-op in remote-less mode when the target already has everything', async () => {
    const g = gcloudStub();
    const r = await resolveConductorSecrets({ env: { HARMONY_CONDUCTOR_HOST_FILE: HOST }, target: { HARMONY_API_TOKEN: 'a', HARMONY_APP_PRIVATE_KEY: 'b' }, exec: g.exec, readFile: files(host()) });
    expect(r.skipped).toEqual(['HARMONY_API_TOKEN', 'HARMONY_APP_PRIVATE_KEY']);
    expect(g.calls).toEqual([]);
  });

  it('places the token and the App key in the target env, with names (not values) in argv', async () => {
    const g = gcloudStub();
    const target: Record<string, string | undefined> = {};
    const r = await resolveConductorSecrets({ env: REMOTE, target, exec: g.exec, readFile: files(host()) });
    expect(r.resolved).toEqual(['HARMONY_API_TOKEN', 'HARMONY_APP_PRIVATE_KEY']);
    expect(target.HARMONY_API_TOKEN).toBe('tok-VALUE-1234'); // trailing newline stripped
    expect(target.HARMONY_APP_PRIVATE_KEY).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    expect(g.calls).toEqual([
      { file: 'gcloud', args: ['secrets', 'versions', 'access', 'latest', '--secret=harmony-api-token', '--project=proj-1'] },
      { file: 'gcloud', args: ['secrets', 'versions', 'access', 'latest', '--secret=harmony-app-key', '--project=proj-1'] },
    ]);
    // no value appears in any argument
    expect(JSON.stringify(g.calls)).not.toContain('VALUE');
    expect(JSON.stringify(g.calls)).not.toContain('BEGIN');
  });

  it('leaves the existing keys (base, codex_auth) alone: they are never resolved here', async () => {
    const g = gcloudStub();
    await resolveConductorSecrets({ env: REMOTE, target: {}, exec: g.exec, readFile: files(host({ secrets: { base: 'harmony-worker-base-env', codex_auth: 'harmony-codex-auth', api_token: 'harmony-api-token' } })) });
    expect(g.calls.map((c) => c.args[4])).toEqual(['--secret=harmony-api-token']);
  });

  it('an env value already set wins and costs no call', async () => {
    const g = gcloudStub();
    const target: Record<string, string | undefined> = { HARMONY_API_TOKEN: 'from-env', HARMONY_APP_PRIVATE_KEY: 'pem-from-env' };
    const r = await resolveConductorSecrets({ env: REMOTE, target, exec: g.exec, readFile: files(host()) });
    expect(r.skipped).toEqual(['HARMONY_API_TOKEN', 'HARMONY_APP_PRIVATE_KEY']);
    expect(g.calls).toEqual([]);
    expect(target.HARMONY_API_TOKEN).toBe('from-env');
  });

  it('takes the project from the environment when the host file names none', async () => {
    const g = gcloudStub();
    await resolveConductorSecrets({ env: { ...REMOTE, HARMONY_GCP_PROJECT: 'env-proj' }, target: {}, exec: g.exec, readFile: files(host({ gcp: undefined })) });
    expect(g.calls[0].args).toContain('--project=env-proj');
  });

  it('a missing api_token entry fails naming the key; a missing App key entry is fine', async () => {
    const g = gcloudStub();
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: g.exec, readFile: files(host({ secrets: { base: 'b' } })) })).rejects.toThrow(/no "api_token" entry/);
    const ok = await resolveConductorSecrets({ env: REMOTE, target: {}, exec: g.exec, readFile: files(host({ secrets: { api_token: 'harmony-api-token' } })) });
    expect(ok.resolved).toEqual(['HARMONY_API_TOKEN']);
  });

  it('a gcloud failure names the secret NAME only — no stdout, no stderr, no value', async () => {
    const g = gcloudStub({ fail: new Set(['harmony-app-key']) });
    const err = await resolveConductorSecrets({ env: REMOTE, target: {}, exec: g.exec, readFile: files(host()) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConductorSecretsError);
    const msg = (err as Error).message;
    expect(msg).toContain('"harmony-app-key"');
    expect(msg).toContain('HARMONY_APP_PRIVATE_KEY');
    expect(msg).not.toContain('tok-VALUE');
  });

  it('an unreachable gcloud (127) says so; an empty secret is an error', async () => {
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: async () => ({ code: 127, stdout: '' }), readFile: files(host()) })).rejects.toThrow(/gcloud is not installed/);
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: gcloudStub().exec, readFile: files(host({ secrets: { api_token: 'empty-one' } })) })).rejects.toThrow(/secret "empty-one".*is empty/);
  });

  it('no project anywhere is an error naming the secret', async () => {
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: gcloudStub().exec, readFile: files(host({ gcp: undefined })) })).rejects.toThrow(/cannot read secret "harmony-api-token": no GCP project/);
  });

  it('an unreadable or invalid host file is an error that does not echo values', async () => {
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: gcloudStub().exec, readFile: () => { throw new Error('ENOENT'); } })).rejects.toThrow(/could not be read/);
    await expect(resolveConductorSecrets({ env: REMOTE, target: {}, exec: gcloudStub().exec, readFile: () => 'not json' })).rejects.toThrow(/not valid JSON/);
    const pasted = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const err = await resolveConductorSecrets({ env: REMOTE, target: {}, exec: gcloudStub().exec, readFile: files(host({ secrets: { api_token: pasted } })) }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('secrets.api_token');
    expect((err as Error).message).not.toContain(pasted);
  });
});

describe('the secrets block schema (names only, still enforced)', () => {
  it('accepts the documented remote keys', () => {
    expect(HostFileSchema.safeParse({ version: 1, secrets: { api_token: 'harmony-api-token', github_app_private_key: 'harmony-app-key' } }).success).toBe(true);
  });
  it('refuses a pasted token under the new keys too', () => {
    expect(HostFileSchema.safeParse({ version: 1, secrets: { api_token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }).success).toBe(false);
    expect(HostFileSchema.safeParse({ version: 1, secrets: { github_app_private_key: '-----BEGIN PRIVATE KEY-----' } }).success).toBe(false);
  });
});
