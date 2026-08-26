// B-844: formatDaemonError must never reproduce the old broken renderings that made daemon
// failures unusable in logs — bare "TypeError: fetch failed" (cause discarded), bare
// "Token exchange failed (502)" (endpoint/body discarded), and "[object Object]" (a non-Error
// rejection coerced to a string). Fixtures below are built as ERROR VALUES that would have
// produced each captured broken log line under the old `err instanceof Error ? err.message :
// String(err)` pattern — the negative assertions are what actually prove the fix.

import { describe, it, expect } from 'vitest';
import { formatDaemonError } from './error-format.js';
import { TokenExchangeError } from '../auth.js';

describe('formatDaemonError', () => {
  it('a raw fetch() network failure AS THE SUPABASE CLIENT ACTUALLY SURFACES IT: a plain rejection ' +
    'object (not a TypeError, no .cause) whose .message is "TypeError: fetch failed" and whose ' +
    '.details carries the real cause chain — renders the details content, not bare ' +
    '"TypeError: fetch failed"', () => {
    // B-844 verify-gate rejection: the conduction-record.ts throw sites used to do
    // `throw new Error(error.message)`, discarding everything but the message string BEFORE
    // formatDaemonError ever saw the value. Now that those sites `throw error` directly, this is
    // the real shape formatDaemonError receives for a daemon DB call that fails at the network
    // level — confirmed via dist/index.js: the Supabase client (via @supabase/postgrest-js) catches
    // the underlying fetch() rejection and returns { error: { message, details, hint, code } }, a
    // PLAIN OBJECT, not an Error instance and with no `.cause` property. The real cause chain
    // (ECONNRESET/errno/etc) lives in `.details` as a formatted string.
    const rejection = {
      message: 'TypeError: fetch failed',
      details: 'TypeError: fetch failed <- Error: connect ECONNRESET <- errno=-104 code=ECONNRESET',
      hint: '',
      code: '',
    };

    const out = formatDaemonError(rejection);

    // Negative: not the bare old rendering — the whole point of this regression test.
    expect(out).not.toBe('TypeError: fetch failed');
    // Positive: the real cause content (from .details) survives into the rendered output.
    expect(out).toContain('ECONNRESET');
    expect(out).toContain(rejection.details);
  });

  it('a synthetic TypeError with a .cause chain (an isolated unit test of the cause-walking rule ' +
    'itself, NOT a claim about the Supabase-rejection shape above): renders the .cause chain, not ' +
    'bare "TypeError: fetch failed"', () => {
    const cause = { code: 'ECONNRESET', errno: -104 };
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = cause;

    const out = formatDaemonError(err);

    // Negative: not the bare old rendering.
    expect(out).not.toBe('TypeError: fetch failed');
    // Positive: names the real cause.
    expect(out).toContain('ECONNRESET');
    expect(out).toContain('fetch failed');
  });

  it('the structured HTTP token-exchange error: renders endpoint + status + body, not bare "Token exchange failed (502)"', () => {
    // Mirrors a real captured line:
    //   conduction c1: heartbeat write failed, retrying next tick (Error: Token exchange failed (502))
    const body = { message: 'upstream unavailable', code: 'UPSTREAM_ERROR' };
    const err = new TokenExchangeError('/functions/v1/auth-token', 502, body);

    const out = formatDaemonError(err);

    // Negative: not the bare old rendering (message alone, nothing else attached).
    expect(out).not.toBe('Token exchange failed (502)');
    expect(out).not.toBe('Error: Token exchange failed (502)');
    // Positive: endpoint, status, and body content are all present.
    expect(out).toContain('/functions/v1/auth-token');
    expect(out).toContain('502');
    expect(out).toContain('upstream unavailable');
    expect(out).toContain('UPSTREAM_ERROR');
  });

  it('a non-Error rejection (PostgREST/edge-function JSON error body): JSON.stringify, not "[object Object]"', () => {
    // Mirrors a real captured line:
    //   pass error — row skipped ([object Object])
    const rejection = {
      message: 'permission denied for table tasks',
      code: '42501',
      details: null,
      hint: 'check row level security policy',
    };

    const out = formatDaemonError(rejection);

    // Negative: not the old bare-coercion rendering.
    expect(out).not.toBe('[object Object]');
    // Positive: the object's keys are all present in the rendered output.
    expect(out).toContain('permission denied for table tasks');
    expect(out).toContain('42501');
    expect(out).toContain('hint');
    expect(out).toContain('check row level security policy');
  });

  it('falls back to String() if JSON.stringify throws (circular reference) — does not throw out of the formatter', () => {
    const circular: Record<string, unknown> = { message: 'boom' };
    circular.self = circular;

    // JSON.stringify on a circular object throws; the formatter must not propagate that — it
    // must fall back to String(err) rather than let a formatting bug crash the caller. (String()
    // on a plain object legitimately IS "[object Object]" — that degraded fallback is the
    // documented behavior for this rare edge case, per the JSON.stringify try/catch spec; it is
    // not the bug this ticket fixes, which is the PRIMARY non-Error path using bare String()
    // unconditionally instead of JSON.stringify.)
    expect(() => formatDaemonError(circular)).not.toThrow();
    expect(typeof formatDaemonError(circular)).toBe('string');
  });

  it('a plain Error with no cause and no HTTP shape: still renders name + message', () => {
    const err = new Error('JWT expired');
    const out = formatDaemonError(err);
    expect(out).toContain('JWT expired');
  });

  it('threads the endpoint hint through for a cause-chained error when opts.endpoint is given', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = { code: 'ENOTFOUND' };

    const out = formatDaemonError(err, { endpoint: '/functions/v1/auth-token' });

    expect(out).toContain('/functions/v1/auth-token');
    expect(out).toContain('ENOTFOUND');
  });
});
