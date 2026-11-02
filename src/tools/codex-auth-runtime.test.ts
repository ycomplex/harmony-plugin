import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runOwner, runWorker, type CredentialServices } from './codex-auth-runtime.js';
import { accessFromGrant, type CodexGrant } from './codex-auth.js';
import { atomicPrivateJson } from './codex-auth-files.js';
const now = 1793620800000;
const ref = 'projects/fixture/secrets/harmony-codex-access';
function grant(generation = 1, expires = now + 3600000, user = 'fixture-user'): CodexGrant {
  const token = `e30.${Buffer.from(JSON.stringify({ exp: expires / 1000,
    'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'fixture-account' }, generation })).toString('base64url')}.fixture`;
  return { id_token: token, access_token: token, refresh_token: 'fixture-refresh', account_id: 'fixture-account' };
}
const services = (): CredentialServices => ({ now: () => now, google: async () => ({}), oauth: async () => grant(2), sleep: async () => {} });
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'b1306-runtime-fixture-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
describe('credential runtime with synthetic files and injected services', () => {
  it('initializes an access-only publication after the full grant is durable', async () => fixture(async dir => {
    const g = grant();
    await writeFile(join(dir, 'fresh-login.json'), JSON.stringify({ tokens: g }));
    const ports = services();
    ports.google = async (path, init) => {
      expect(path).toBe(`${ref}:addVersion`);
      expect(JSON.parse(await readFile(join(dir, 'grant.json'), 'utf8')).grant).toEqual(g);
      const access = JSON.parse(Buffer.from(JSON.parse(init!.body as string).payload.data, 'base64').toString());
      expect(access.auth.tokens.refresh_token).toBe('');
      return {};
    };
    await runOwner(dir, ref, true, ports);
    await expect(stat(join(dir, 'fresh-login.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, 'in-flight'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('publishes a rotation only after persisting it and leaves a crash fence on failure', async () => fixture(async dir => {
    await atomicPrivateJson(join(dir, 'grant.json'), { grant: grant(1, now + 120000), generation: 1 });
    const ports = services();
    ports.oauth = vi.fn(async () => grant(2));
    ports.google = async () => {
      expect(JSON.parse(await readFile(join(dir, 'grant.json'), 'utf8')).generation).toBe(2);
      throw new Error('fixture publication interrupted');
    };
    await expect(runOwner(dir, ref, false, ports)).rejects.toThrow('refresh-uncertain');
    await expect(runOwner(dir, ref, false, ports)).rejects.toThrow('refresh-uncertain');
    expect(ports.oauth).toHaveBeenCalledTimes(1);
  }));
  it('does not refresh or publish a healthy grant', async () => fixture(async dir => {
    await atomicPrivateJson(join(dir, 'grant.json'), { grant: grant(), generation: 1 });
    const ports = services(); ports.oauth = vi.fn(); ports.google = vi.fn();
    await runOwner(dir, ref, false, ports);
    expect(ports.oauth).not.toHaveBeenCalled(); expect(ports.google).not.toHaveBeenCalled();
  }));
  it('updates parallel workers and subsequent launches, rejecting rollback and owner mismatch', async () => fixture(async dir => {
    let access = accessFromGrant(grant(), 1, now);
    const ports = services(); ports.oauth = vi.fn();
    ports.google = async path => {
      expect(path).toBe(`${ref}/versions/latest:access`);
      return { payload: { data: Buffer.from(JSON.stringify(access)).toString('base64') } };
    };
    for (const generation of [1, 2]) {
      access = accessFromGrant(grant(generation), generation, now);
      await Promise.all(['first', 'second'].map(home => runWorker(join(dir, home), ref, true, ports)));
    }
    expect(JSON.parse(await readFile(join(dir, 'first/auth.json'), 'utf8'))).toEqual(access.auth);
    await runWorker(join(dir, 'subsequent'), ref, true, ports);
    access = accessFromGrant(grant(), 1, now);
    await expect(runWorker(join(dir, 'first'), ref, true, ports)).rejects.toThrow('identity-mismatch');
    access = accessFromGrant(grant(3, now + 3600000, 'other'), 3, now);
    await expect(runWorker(join(dir, 'first'), ref, true, ports)).rejects.toThrow('identity-mismatch');
    expect(ports.oauth).not.toHaveBeenCalled();
  }));
  it('recovers an interrupted install during delivery outage but refuses an expired generation', async () => fixture(async dir => {
    const access = accessFromGrant(grant(), 1, now);
    await atomicPrivateJson(join(dir, 'access-generation.json'), access);
    const ports = services(); ports.google = async () => { throw new Error('fixture network unavailable'); };
    await runWorker(dir, ref, true, ports);
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual(access.auth);
    ports.now = () => now + 3600000;
    await expect(runWorker(dir, ref, true, ports)).rejects.toThrow('expired');
  }));
});
