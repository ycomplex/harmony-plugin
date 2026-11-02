/** B-1306 credential owner/updater. No raw remote errors or credentials reach stdout/stderr. */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { codexLoginFailure, persistCodexAuthFailure, CodexLoginError, type CodexGrant } from '../tools/codex-auth.js';
import { getAuthenticatedContext } from '../cli/auth.js';
import { addComment } from '../tools/comments.js';
import { advanceWorkflow } from '../tools/workflow.js';
import { runOwner, runWorker, type CredentialServices } from '../tools/codex-auth-runtime.js';

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
const services: CredentialServices = {
  now: Date.now,
  google,
  sleep: () => delay(30000),
  oauth: async old => {
    const response = await fetch('https://auth.openai.com/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: old.refresh_token }) });
    if (!response.ok) throw new Error('refresh refused');
    return { ...await response.json() as CodexGrant, account_id: old.account_id };
  },
};
async function main(): Promise<void> {
  // Explicitly inert, even if this binary is accidentally started by an old image/manifest.
  if (process.env.HARMONY_CODEX_TOKEN_ONLY !== '1') return;
  if (process.argv[2] !== 'owner' && (process.env.HARMONY_CODEX_PROVIDER ?? 'openai') !== 'openai') return;
  switch (process.argv[2]) {
    case 'check-output': {
      const reason = codexLoginFailure(await readFile(process.argv[3], 'utf8'));
      if (reason) throw new CodexLoginError(reason);
      break;
    }
    case 'owner': await runOwner(required('HARMONY_CODEX_AUTH_OWNER_DIR'), resource(), process.argv.includes('--initialize'), services); break;
    case 'worker': await runWorker(required('CODEX_HOME'), resource(), process.argv.includes('--once'), services); break;
    default: throw new Error('codex-login-configuration-missing');
  }
}
main().catch(async error => {
  const reason = error instanceof CodexLoginError ? error.reason :
    process.argv[2] === 'owner' ? 'codex-login-refresh-uncertain' : 'codex-auth-service-unavailable';
  console.error(`${reason}: stop dispatch; founder must recover the dedicated login and republish access-only credentials. Never retry an uncertain refresh.`);
  if (process.env.TICKET) {
    let ctx: Awaited<ReturnType<typeof getAuthenticatedContext>>;
    await persistCodexAuthFailure({
      comment: async () => {
        ctx = await getAuthenticatedContext();
        await addComment(ctx.client, ctx.projectId, ctx.userId, { task_id: process.env.TICKET!,
          content: `${reason}: Codex authentication stopped this leg. Founder: stop dispatch and use the Codex credential recovery runbook. No credential values are included. Network/service unavailability alone does not establish login expiry.` });
      },
      park: async () => { await advanceWorkflow(ctx.client, ctx.projectId, { task_id: process.env.TICKET!, activity: 'parking' }); },
      boardWriteFailed: () => console.error('codex-auth-board-write-failed: conductor must inspect this leg; named authentication status was not persisted'),
    });
  }
  if (process.argv.includes('--watch')) process.kill(process.ppid, 'SIGTERM');
  process.exitCode = 1;
});
