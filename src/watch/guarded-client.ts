/**
 * `harmony watch`'s own Supabase client (B-1422).
 *
 * Same shape as `createAuthenticatedClient` (src/supabase.ts), which is deliberately not edited:
 * that client's `accessToken` callback has no catch, so a token exchange that fails while a
 * long-lived watch is offline would reject inside supabase-js and, on the realtime path, surface
 * as an unhandled rejection. Here the callback:
 *   - remembers the last token that was handed out successfully;
 *   - on failure reports `onHealth({ kind, error })` (`auth-failed` for a rejected token,
 *     `offline` for anything else) and returns the last good token if there is one;
 *   - with no good token yet, rethrows, so the caller's poll catches it and backs off.
 *
 * `installProcessGuards(onHealth)` keeps a stray rejection or exception from killing the watch.
 * It ignores broken-pipe errors (`isBrokenPipe`): the watch handles a closed stdout itself, and a
 * health line about it would be written to the same dead pipe (B-1429).
 * Token values are never logged.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TokenExchangeError } from '../auth.js';
import { redactFigmaMessage } from '../cli/figma-errors.js';

export type GuardHealthKind = 'auth-failed' | 'offline';

export interface GuardHealth {
  kind: GuardHealthKind;
  error: unknown;
}

/** The slice of HarmonyAuth the guarded client needs (a real HarmonyAuth satisfies it). */
export interface AuthLike {
  getAccessToken(): Promise<string>;
  getSupabaseUrl(): string;
  getSupabaseAnonKey(): string;
}

/** Is this error a rejected credential (rather than a network or server failure)? */
export function isAuthError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof TokenExchangeError) return err.status === 401 || err.status === 403;
  const e = err as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'TokenExchangeError' && (e.status === 401 || e.status === 403)) return true;
  if (e.code === 'PGRST301' || e.code === 'PGRST303') return true;
  if (e.status === 401) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  if (/Token exchange failed \((401|403)\)/.test(msg)) return true;
  if (/JWT expired|invalid JWT|JWSError/i.test(msg)) return true;
  return false;
}

/** A guarded token getter: the `accessToken` callback, testable without a client. */
export function guardedTokenGetter(auth: Pick<AuthLike, 'getAccessToken'>, onHealth: (h: GuardHealth) => void): () => Promise<string> {
  let lastGood: string | null = null;
  return async () => {
    try {
      const token = await auth.getAccessToken();
      lastGood = token;
      return token;
    } catch (error) {
      try {
        onHealth({ kind: isAuthError(error) ? 'auth-failed' : 'offline', error });
      } catch {
        // a broken health sink must not break the request path
      }
      if (lastGood !== null) return lastGood;
      throw error;
    }
  };
}

export function createGuardedClient(auth: AuthLike, onHealth: (h: GuardHealth) => void): SupabaseClient {
  return createClient(auth.getSupabaseUrl(), auth.getSupabaseAnonKey(), {
    accessToken: guardedTokenGetter(auth, onHealth),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export interface ProcessGuardHealth {
  kind: 'unhandled-rejection' | 'uncaught-exception';
  error: unknown;
}

/** Is this a write to a closed pipe or a destroyed stream (`EPIPE`, `ERR_STREAM_DESTROYED`)? */
export function isBrokenPipe(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

/**
 * Register `unhandledRejection` and `uncaughtException` handlers that report a health line and do
 * NOT exit. Broken-pipe errors (`isBrokenPipe`) are ignored: no health line, no write. Returns a
 * disposer that removes exactly these handlers.
 */
export function installProcessGuards(onHealth: (h: ProcessGuardHealth) => void, proc: NodeJS.Process = process): () => void {
  const onRejection = (error: unknown) => {
    if (isBrokenPipe(error)) return;
    try {
      onHealth({ kind: 'unhandled-rejection', error });
    } catch {
      // never rethrow from a guard
    }
  };
  const onException = (error: unknown) => {
    if (isBrokenPipe(error)) return;
    try {
      onHealth({ kind: 'uncaught-exception', error });
    } catch {
      // never rethrow from a guard
    }
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}

/** An error's message with bearer tokens, JWTs and the given secrets redacted. */
export function safeErrorMessage(err: unknown, secrets: string[] = []): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return redactFigmaMessage(raw, secrets);
}
