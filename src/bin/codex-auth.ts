/** B-1306 credential owner/updater. No raw remote errors or credentials reach stdout/stderr. */
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accessFromGrant, validateAccess, refreshCodex, codexLoginFailure, CodexLoginError, type CodexAccess, type CodexGrant } from '../tools/codex-auth.js';
import { getAuthenticatedContext } from '../cli/auth.js';
import { addComment } from '../tools/comments.js';
import { advanceWorkflow } from '../tools/workflow.js';
import { atomicPrivateJson, claimRefresh } from '../tools/codex-auth-files.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('codex-login-configuration-missing');
  return value;
}
async function google(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10000) });
  if (!token.ok) throw new Error('credential-service-unavailable');
  const auth = await token.json() as { access_token: string };
  const response = await fetch(`https://secretmanager.googleapis.com/v1/${path}`, { ...init,
    headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('credential-service-unavailable');
  return response.json();
}
function resource(): string {
  const ref = required('HARMONY_CODEX_ACCESS_RESOURCE');
  if (!/^projects\/[a-zA-Z0-9-]+\/secrets\/harmony-codex-access$/.test(ref)) throw new Error('codex-login-configuration-missing');
  return ref;
}
async function owner(initialize: boolean): Promise<void> {
  const dir = required('HARMONY_CODEX_AUTH_OWNER_DIR');
  const ref = resource();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, 'in-flight');
  // O_EXCL is the durable ownership fence, including across pods. Never remove it on a failed attempt.
  if (!await claimRefresh(marker)) throw new CodexLoginError('codex-login-refresh-uncertain');
  const path = join(dir, 'grant.json');
  if (initialize) {
    // Founder supplies a NEW dedicated grant directly on this private volume. No shared login read.
    const original = JSON.parse(await readFile(join(dir, 'fresh-login.json'), 'utf8')) as { tokens: CodexGrant };
    const access = accessFromGrant(original.tokens, 1, Date.now());
    await atomicPrivateJson(path, { grant: original.tokens, generation: 1 });
    await google(`${ref}:addVersion`, { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(access)).toString('base64') } }) });
    await unlink(join(dir, 'fresh-login.json'));
    await unlink(marker);
    console.log('codex-auth: initialized access generation 1');
    return;
  }
  const stored = JSON.parse(await readFile(path, 'utf8')) as { grant: CodexGrant; generation: number };
  const current = accessFromGrant(stored.grant, stored.generation, 0);
  // Refresh early; the job runs every minute. A healthy grant is never needlessly spent.
  if (current.expires_at > Date.now() + 10 * 60_000) { await unlink(marker); return; }
  await refreshCodex({ generation: stored.generation, grant_version: 'private-volume', in_flight: false, blocked: false }, {
    claim: async () => true, // Already durably fenced above, before reading the full grant.
    readGrant: async () => stored.grant,
    refresh: async old => {
      const response = await fetch('https://auth.openai.com/oauth/token', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: old.refresh_token }) });
      if (!response.ok) throw new Error('refresh refused');
      const rotated = await response.json() as CodexGrant;
      return { ...rotated, account_id: old.account_id };
    },
    persistGrant: async next => { await atomicPrivateJson(path, { grant: next, generation: stored.generation + 1 }); return 'private-volume'; },
    publishAccess: async access => { await google(`${ref}:addVersion`, { method: 'POST',
      body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(access)).toString('base64') } }) }); },
    finish: async () => { await unlink(marker); },
  }, Date.now());
  console.log('codex-auth: published access generation');
}
async function worker(once: boolean): Promise<void> {
  const ref = resource();
  const home = required('CODEX_HOME');
  await mkdir(home, { recursive: true, mode: 0o700 });
  let previous: CodexAccess | null = null;
  try { previous = JSON.parse(await readFile(join(home, 'access-generation.json'), 'utf8')) as CodexAccess; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  do {
    try {
      const response = await google(`${ref}/versions/latest:access`) as { payload: { data: string } };
      const access = validateAccess(JSON.parse(Buffer.from(response.payload.data, 'base64').toString()), previous, Date.now());
      await atomicPrivateJson(join(home, 'access-generation.json'), access);
      await atomicPrivateJson(join(home, 'auth.json'), access.auth);
      previous = access;
    } catch (error) {
      // A transient publication outage can use the already installed, still-valid generation.
      if (error instanceof CodexLoginError || !previous) throw error;
      if (previous.expires_at <= Date.now() + 60_000) throw new CodexLoginError('codex-login-expired');
    }
    if (!once) await delay(30000);
  } while (!once);
}
async function main(): Promise<void> {
  // Explicitly inert, even if this binary is accidentally started by an old image/manifest.
  if (process.env.HARMONY_CODEX_TOKEN_ONLY !== '1') return;
  switch (process.argv[2]) {
    case 'check-output': {
      const reason = codexLoginFailure(await readFile(process.argv[3], 'utf8'));
      if (reason) throw new CodexLoginError(reason);
      break;
    }
    case 'owner': await owner(process.argv.includes('--initialize')); break;
    case 'worker': await worker(process.argv.includes('--once')); break;
    default: throw new Error('codex-login-configuration-missing');
  }
}
main().catch(async error => {
  const reason = error instanceof CodexLoginError ? error.reason :
    process.argv[2] === 'owner' ? 'codex-login-refresh-uncertain' : 'codex-auth-service-unavailable';
  console.error(`${reason}: stop dispatch; founder must recover the dedicated login and republish access-only credentials. Never retry an uncertain refresh.`);
  if (process.env.TICKET) {
    try {
      const ctx = await getAuthenticatedContext();
      await addComment(ctx.client, ctx.projectId, ctx.userId, { task_id: process.env.TICKET,
        content: `${reason}: Codex authentication stopped this leg. Founder: stop dispatch and use the Codex credential recovery runbook. No credential values are included. Network/service unavailability alone does not establish login expiry.` });
      await advanceWorkflow(ctx.client, ctx.projectId, { task_id: process.env.TICKET, activity: 'parking' });
    } catch { console.error('codex-auth-board-write-failed: conductor must inspect this leg; named authentication status was not persisted'); }
  }
  if (process.argv.includes('--watch')) process.kill(process.ppid, 'SIGTERM');
  process.exitCode = 1;
});
