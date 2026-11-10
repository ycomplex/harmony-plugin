import { generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { runAppCheck } from './conductor-check-app.js';
import { registerConductorCommands } from './conductor-config.js';
// Standalone runtime scripts deliberately stay outside the TypeScript compilation root.
// @ts-expect-error untyped .mjs runtime module
import { checkInstallation, EXPECTED_PERMISSIONS } from '../../../scripts/check-app-installation.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
const opts = { appId: '123', installationId: '456', privateKeyPath: '/explicit/key.pem' };
const sentinel = 'FAKE_SECRET_SENTINEL';
const repo = (n: number) => ({ id: n, full_name: `example/repo-${n}`, token: sentinel });
const installation = () => ({ id: 456, app_id: 123, suspended_at: null, permissions: { ...EXPECTED_PERMISSIONS }, events: [], repository_selection: 'selected', token: sentinel });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function harness(change: Record<string, unknown> = {}, pages = [{ total_count: 1, repositories: [repo(1)] }]) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    expect(url.startsWith('https://api.github.com/')).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.includes('/access_tokens')) {
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      return json({ token: sentinel });
    }
    if (url.includes('/app/installations/')) {
      const jwt = (init.headers as Record<string, string>).Authorization.slice(7);
      const [header, body, signature] = jwt.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256');
      expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({ iat: 1799999940, exp: 1800000540, iss: '123' });
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
      return json({ ...installation(), ...change });
    }
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${sentinel}`);
    const page = Number(new URL(url).searchParams.get('page'));
    return json(pages[page - 1]);
  });
  const readKey = vi.fn(() => key);
  const run = () => checkInstallation(opts, { readKey, fetchImpl, nowSeconds: 1800000000 });
  return { fetchImpl, readKey, run };
}
async function wrap(data: any) {
  return runAppCheck(opts, { root: '/installed/plugin', run: async (file, args) => {
    expect(file).toBe('/installed/plugin/scripts/check-app-installation.mjs');
    expect(args).toEqual(['--app-id', '123', '--installation-id', '456', '--private-key-path', '/explicit/key.pem']);
    return { stdout: JSON.stringify(data), exitCode: data.ok ? 0 : 1 };
  } });
}
describe('GitHub App installation check', () => {
  it('reuses signing and minting, validates identity and projects only safe public output', async () => {
    const h = harness();
    const data = await h.run();
    expect(data.ok).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    const output = await wrap(data);
    expect(output.exitCode).toBe(0);
    expect(output.lines).toContain('OK: yes');
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(JSON.stringify(output)).not.toContain(opts.privateKeyPath);
  });
  it('collects all pages, including a terminal empty page for exact multiples of 100', async () => {
    const first = Array.from({ length: 100 }, (_, i) => repo(i + 1));
    const data = await harness({}, [{ total_count: 100, repositories: first }, { total_count: 100, repositories: [] }]).run();
    expect(data.ok).toBe(true);
    expect(data.repositories).toHaveLength(100);
  });
  it('collects multiple populated pages and sorts names', async () => {
    const data = await harness({}, [{ total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => repo(i + 1)) }, { total_count: 101, repositories: [repo(101)] }]).run();
    expect(data.ok).toBe(true);
    expect(data.repositories).toEqual([...data.repositories].sort());
  });
  it.each([
    { permissions: { ...EXPECTED_PERMISSIONS, administration: 'write' } },
    { permissions: { ...EXPECTED_PERMISSIONS, contents: 'read' } },
    { permissions: { ...EXPECTED_PERMISSIONS, checks: undefined } },
    { events: ['push'] },
  ])('fails closed for unexpected grants/events: %j', async (change) => {
    const data = await harness(change).run();
    expect(data.ok).toBe(false);
    expect((await wrap(data)).exitCode).toBe(1);
  });
  it('names each missing, extra and wrong-level grant in human output', async () => {
    const grants = { ...EXPECTED_PERMISSIONS, contents: 'read', administration: 'write' };
    delete grants.checks;
    const data = await harness({ permissions: grants, events: ['push'] }).run();
    const output = await wrap(data);
    expect(output.lines).toContain('Missing permissions: checks');
    expect(output.lines).toContain('Extra permissions: administration');
    expect(output.lines).toContain('Wrong-level permissions: contents=read (expected write)');
    expect(output.lines).toContain('Unexpected events: push');
  });
  it.each([{ app_id: 999 }, { id: 999 }, { suspended_at: '2026-11-10T00:00:00Z' }, { events: sentinel }, { permissions: { x: sentinel } }, { repository_selection: sentinel }])('rejects bad installation before minting', async (change) => {
    const h = harness(change);
    const data = await h.run();
    expect(data.ok).toBe(false);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await wrap(data))).not.toContain(sentinel);
  });
  it.each([
    [{ total_count: 2, repositories: [repo(1)] }],
    [{ total_count: 100, repositories: Array.from({ length: 100 }, () => repo(1)) }],
    [{ total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => repo(i + 1)) }, { total_count: 102, repositories: [repo(101)] }],
    [{ total_count: 100, repositories: Array.from({ length: 100 }, (_, i) => repo(i + 1)) }, { total_count: 100, repositories: [repo(1)] }],
    [{ total_count: 1, repositories: [{ id: 1, full_name: 'bad\nname' }] }],
    [{ total_count: -1, repositories: [] }],
  ])('rejects partial, malformed, repeated or inconsistent pages', async (...pages) => {
    const data = await harness({}, pages as any).run();
    expect(data.ok).toBe(false);
    expect(data.repositories_complete).toBe(false);
  });
  it('bounds pagination even when every page is full', async () => {
    let page = 0;
    const h = harness();
    const data = await checkInstallation(opts, { readKey: () => key, nowSeconds: 1800000000,
      fetchImpl: async (url: string, init: RequestInit) => {
        if (!url.includes('/installation/repositories')) return h.fetchImpl(url, init);
        page++;
        return json({ total_count: 100_000, repositories: Array.from({ length: 100 }, (_, i) => repo((page - 1) * 100 + i + 1)) });
      },
    });
    expect(page).toBe(1000);
    expect(data.error.code).toBe('page-limit');
    expect(data.ok).toBe(false);
  });
  it('rejects missing or malformed mint tokens without exposing raw bodies', async () => {
    for (const token of [undefined, { secret: sentinel }]) {
      const h = harness();
      const data = await checkInstallation(opts, { readKey: () => key, nowSeconds: 1800000000,
        fetchImpl: async (url: string, init: RequestInit) => url.includes('/access_tokens') ? json({ token, message: sentinel }) : h.fetchImpl(url, init),
      });
      expect(data.ok).toBe(false);
      expect(JSON.stringify(await wrap(data))).not.toContain(sentinel);
    }
  });
  it('accepts an empty accessible repository set and selection all', async () => {
    expect((await harness({ repository_selection: 'all' }, [{ total_count: 0, repositories: [] }]).run()).ok).toBe(true);
  });
  it('rejects invalid ids before reading any key', async () => {
    const readKey = vi.fn();
    const data = await checkInstallation({ ...opts, appId: '123;bad' }, { readKey });
    expect(data.ok).toBe(false);
    expect(readKey).not.toHaveBeenCalled();
  });
  it.each(['key', 'installation', 'mint', 'repositories'])('sanitizes exceptions at %s', async (stage) => {
    let count = 0;
    const h = harness();
    const data = await checkInstallation(opts, { nowSeconds: 1800000000,
      readKey: () => { if (stage === 'key') throw new Error(sentinel); return key; },
      fetchImpl: async (...args: any[]) => { count++; if (count === { installation: 1, mint: 2, repositories: 3 }[stage]) throw new Error(sentinel); return h.fetchImpl(...args as [string, RequestInit]); },
    });
    expect(data.ok).toBe(false);
    expect(JSON.stringify(await wrap(data))).not.toContain(sentinel);
  });
  it.each([401, 403, 404, 429, 500])('reports only HTTP status on failure %i', async (status) => {
    const data = await checkInstallation(opts, { readKey: () => key, fetchImpl: async () => json({ message: sentinel }, status) });
    expect(data.error).toEqual({ stage: 'installation', code: 'request-failed', http_status: status });
    expect(JSON.stringify(await wrap(data))).not.toContain(sentinel);
  });
  it('rejects unsafe imported API overrides before sending the JWT', async () => {
    vi.resetModules(); vi.stubEnv('GITHUB_API_URL', 'https://attacker.invalid');
    try {
      // @ts-expect-error standalone module
      const { checkInstallation: overridden } = await import('../../../scripts/check-app-installation.mjs');
      const h = harness();
      const data = await overridden(opts, { readKey: () => key, fetchImpl: h.fetchImpl, nowSeconds: 1800000000 });
      expect(data.error).toEqual({ stage: 'mint', code: 'unsafe-origin' });
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
  it('never echoes child exceptions, arbitrary output or unknown JSON fields', async () => {
    for (const run of [async () => { throw new Error(sentinel); }, async () => ({ stdout: sentinel, exitCode: 1 }), async () => ({ stdout: JSON.stringify({ ...(await harness().run()), token: sentinel }), exitCode: 0 })]) {
      const output = await runAppCheck(opts, { root: '/plugin', run });
      expect(output.exitCode).toBe(1);
      expect(JSON.stringify(output)).not.toContain(sentinel);
    }
  });
  it('registers required explicit arguments and ships the standalone script beside its dependency', () => {
    const program = new Command(); registerConductorCommands(program);
    const cmd = program.commands.find((c) => c.name() === 'conductor')!.commands.find((c) => c.name() === 'check-app')!;
    expect(cmd.options.map((o) => [o.long, o.mandatory])).toEqual([['--app-id', true], ['--installation-id', true], ['--private-key-path', true]]);
    expect(readFileSync(resolve('scripts/check-app-installation.mjs'), 'utf8')).toContain("from './mint-installation-token.mjs'");
    const help = execFileSync(process.execPath, ['dist/bin/harmony.js', 'conductor', 'check-app', '--help'], { encoding: 'utf8' });
    expect(help).toContain('--private-key-path');
    const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }))[0];
    expect(pack.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['scripts/check-app-installation.mjs', 'scripts/mint-installation-token.mjs', '.claude-plugin/plugin.json']));
  });
});
