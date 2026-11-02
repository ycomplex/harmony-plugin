/** B-1306. Pure credential contracts. Errors contain names, never supplied values. */
export class CodexLoginError extends Error {
  constructor(public readonly reason: 'codex-login-expired' | 'codex-login-refresh-uncertain' | 'codex-login-identity-mismatch') {
    super(reason);
  }
}
export interface CodexAccess {
  generation: number;
  expires_at: number;
  account_id: string;
  user_id: string;
  auth: { auth_mode: 'chatgptAuthTokens'; OPENAI_API_KEY: null;
    tokens: { id_token: string; access_token: string; refresh_token: ''; account_id: string } };
}
export interface CodexGrant { id_token: string; access_token: string; refresh_token: string; account_id: string }
function claims(token: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { throw new CodexLoginError('codex-login-identity-mismatch'); }
}
export function accessFromGrant(grant: CodexGrant, generation: number, now: number): CodexAccess {
  const access = claims(grant.access_token);
  const identity = claims(grant.id_token);
  const a = access['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const i = identity['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const user = i?.chatgpt_user_id ?? i?.user_id;
  if (typeof user !== 'string' || !user.trim() || !grant.account_id?.trim() ||
    i?.chatgpt_account_id !== grant.account_id || a?.chatgpt_account_id !== grant.account_id ||
    (a?.chatgpt_user_id ?? a?.user_id) !== user || !Number.isSafeInteger(generation) || generation < 1) {
    throw new CodexLoginError('codex-login-identity-mismatch');
  }
  const expiry = typeof access.exp === 'number' ? access.exp * 1000 : NaN;
  if (!Number.isFinite(expiry) || expiry <= now + 60_000) throw new CodexLoginError('codex-login-expired');
  return { generation, expires_at: expiry, account_id: grant.account_id, user_id: user,
    auth: { auth_mode: 'chatgptAuthTokens', OPENAI_API_KEY: null,
      tokens: { id_token: grant.id_token, access_token: grant.access_token, refresh_token: '', account_id: grant.account_id } } };
}
export function validateAccess(value: unknown, previous: CodexAccess | null, now: number): CodexAccess {
  try {
    const v = value as CodexAccess;
    if (v.auth.auth_mode !== 'chatgptAuthTokens' || v.auth.OPENAI_API_KEY !== null || v.auth.tokens.refresh_token !== '') {
      throw new Error('invalid');
    }
    const checked = accessFromGrant(v.auth.tokens, v.generation, now);
    if (checked.account_id !== v.account_id || checked.user_id !== v.user_id || checked.expires_at !== v.expires_at ||
      (previous && (previous.account_id !== checked.account_id || previous.user_id !== checked.user_id ||
        checked.generation < previous.generation || (checked.generation === previous.generation &&
          JSON.stringify(checked) !== JSON.stringify(previous))))) throw new Error('invalid');
    return checked;
  } catch (error) {
    if (error instanceof CodexLoginError) throw error;
    throw new CodexLoginError('codex-login-identity-mismatch');
  }
}
export interface CodexRefreshState { generation: number; grant_version: string; in_flight: boolean; blocked: boolean }
export interface CodexRefreshPorts {
  /** Compare-and-set the exact durable state. Returns false on a competing owner. */
  claim(state: CodexRefreshState): Promise<boolean>;
  readGrant(version: string): Promise<CodexGrant>;
  refresh(grant: CodexGrant): Promise<CodexGrant>;
  persistGrant(grant: CodexGrant): Promise<string>;
  publishAccess(access: CodexAccess): Promise<void>;
  finish(state: CodexRefreshState, grantVersion: string): Promise<void>;
}
export async function refreshCodex(state: CodexRefreshState, ports: CodexRefreshPorts, now: number): Promise<'ok' | 'skipped'> {
  if (state.in_flight || state.blocked) throw new CodexLoginError('codex-login-refresh-uncertain');
  if (!await ports.claim(state)) return 'skipped';
  // Any failure leaves the durable in-flight marker. A subsequent job must NEVER replay this grant.
  try {
    const old = await ports.readGrant(state.grant_version);
    if (!old.refresh_token) throw new Error('missing grant');
    const next = await ports.refresh(old);
    if (!next.refresh_token) throw new Error('missing rotation');
    const before = accessFromGrant(old, state.generation + 1, 0);
    const access = accessFromGrant(next, state.generation + 1, now);
    if (before.account_id !== access.account_id || before.user_id !== access.user_id) throw new Error('owner changed');
    const version = await ports.persistGrant(next);
    await ports.publishAccess(access);
    await ports.finish(state, version);
    return 'ok';
  } catch {
    throw new CodexLoginError('codex-login-refresh-uncertain');
  }
}

/** Only structured runtime errors, never an assistant's prose or an arbitrary HTTP 401. */
export function codexLoginFailure(output: string): 'codex-login-expired' | null {
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };
      if (event.type !== 'error' && event.type !== 'turn.failed') continue;
      const message = event.message ?? event.error?.message ?? '';
      if (/\btoken_expired\b|refresh token (?:was )?already used|access token could not be refreshed/i.test(message)) return 'codex-login-expired';
    } catch { /* Unstructured output cannot establish an authentication failure. */ }
  }
  return null;
}
