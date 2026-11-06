/** B-1306 runtime I/O with injected remote services. Tests never need real credentials. */
import { mkdir, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { accessFromGrant, validateAccess, refreshCodex, CodexLoginError, type CodexAccess, type CodexGrant } from './codex-auth.js';
import { atomicPrivateJson, claimRefresh } from './codex-auth-files.js';
export interface CredentialServices {
  now(): number;
  google(path: string, init?: RequestInit): Promise<unknown>;
  oauth(grant: CodexGrant): Promise<CodexGrant>;
  sleep(): Promise<void>;
}
export async function runOwner(dir: string, ref: string, initialize: boolean, services: CredentialServices): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, 'in-flight');
  // O_EXCL is the durable ownership fence, including across pods. Never remove it on a failed attempt.
  if (!await claimRefresh(marker)) throw new CodexLoginError('codex-login-refresh-uncertain');
  const path = join(dir, 'grant.json');
  if (initialize) {
    const exists = await stat(path).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new CodexLoginError('codex-login-refresh-uncertain');
    // Founder supplies a NEW dedicated grant directly on this private volume. No shared login read.
    const original = JSON.parse(await readFile(join(dir, 'fresh-login.json'), 'utf8')) as { tokens: CodexGrant };
    const access = accessFromGrant(original.tokens, 1, services.now());
    await atomicPrivateJson(path, { grant: original.tokens, generation: 1 });
    await services.google(`${ref}:addVersion`, { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(access)).toString('base64') } }) });
    await unlink(join(dir, 'fresh-login.json'));
    await unlink(marker);
    console.log('codex-auth: initialized access generation 1');
    return;
  }
  const stored = JSON.parse(await readFile(path, 'utf8')) as { grant: CodexGrant; generation: number };
  const current = accessFromGrant(stored.grant, stored.generation, 0);
  // Refresh early; the job runs every minute. A healthy grant is never needlessly spent.
  if (current.expires_at > services.now() + 10 * 60_000) { await unlink(marker); return; }
  await refreshCodex({ generation: stored.generation, grant_version: 'private-volume', in_flight: false, blocked: false }, {
    claim: async () => true, // Already durably fenced above, before reading the full grant.
    readGrant: async () => stored.grant,
    refresh: services.oauth,
    persistGrant: async next => { await atomicPrivateJson(path, { grant: next, generation: stored.generation + 1 }); return 'private-volume'; },
    publishAccess: async access => { await services.google(`${ref}:addVersion`, { method: 'POST',
      body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(access)).toString('base64') } }) }); },
    finish: async () => { await unlink(marker); },
  }, services.now());
  console.log('codex-auth: published access generation');
}
export async function runWorker(home: string, ref: string, once: boolean, services: CredentialServices): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  let previous: CodexAccess | null = null;
  try { previous = validateAccess(JSON.parse(await readFile(join(home, 'access-generation.json'), 'utf8')), null, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  do {
    let access: CodexAccess;
    try {
      const response = await services.google(`${ref}/versions/latest:access`) as { payload: { data: string } };
      access = validateAccess(JSON.parse(Buffer.from(response.payload.data, 'base64').toString()), previous, services.now());
    } catch (error) {
      if (error instanceof CodexLoginError || !previous) throw error;
      // Validate the installed generation locally during a transient delivery outage.
      access = validateAccess(previous, null, services.now());
    }
    // Local persistence errors are not network outages and must not be silently swallowed.
    await atomicPrivateJson(join(home, 'access-generation.json'), access);
    // B-1407: Codex 0.166.0 sends no bearer unless auth.json carries last_refresh. An unchanged generation
    // keeps its stamp so the periodic rewrite does not churn the file; the stamp lives in a sidecar that
    // holds no credential, because nothing here may read auth.json back (B-1076).
    const last_refresh = await lastRefresh(home, access, previous, services);
    await atomicPrivateJson(join(home, 'last-refresh.json'), { generation: access.generation, last_refresh });
    await atomicPrivateJson(join(home, 'auth.json'), { ...access.auth, last_refresh });
    previous = access;
    if (!once) await services.sleep();
  } while (!once);
}
async function lastRefresh(home: string, access: CodexAccess, previous: CodexAccess | null, services: CredentialServices): Promise<string> {
  if (previous && previous.generation === access.generation) {
    try {
      const stamp = JSON.parse(await readFile(join(home, 'last-refresh.json'), 'utf8')) as { generation?: unknown; last_refresh?: unknown };
      if (stamp.generation === access.generation && typeof stamp.last_refresh === 'string' &&
        Number.isFinite(Date.parse(stamp.last_refresh))) return stamp.last_refresh;
    } catch { /* A missing or unreadable stamp gets a fresh timestamp. */ }
  }
  return new Date(services.now()).toISOString();
}
