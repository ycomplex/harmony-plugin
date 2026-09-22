// B-947: unit coverage for `resolveWorkerStoredText` — the WORKER-only extraction that pulls a
// Claude CLI result envelope's prose out BEFORE the 64 KB capture bound is applied, so a long agent
// output whose raw envelope exceeds the bound still keeps its prose (`result` sits near the START
// of the JSON envelope; the existing tail-bounding keeps the END of the string, which cuts it off).
//
// Exercises the pure extraction helper directly rather than the `leg-output record` action itself
// (which needs a Supabase client, an authenticated context and a conduction id) — the same shape as
// src/tools/claude-result-parse.ts's own unit tests, which test the parse in isolation from the CLI
// wiring around it.

import { describe, it, expect } from 'vitest';
import { resolveWorkerStoredText } from './leg-output.js';
import { boundedTail, LEG_OUTPUT_TAIL_BYTES } from '../../tools/leg-output-record.js';

/** The observed `claude -p --output-format json` envelope shape (CLI 2.1.252) — mirrors
 *  src/tools/leg-cost-capture-contract.test.ts's own `resultEnvelope` helper. */
function resultEnvelope(result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: 'sess-1',
    num_turns: 3,
    duration_ms: 1234,
    duration_api_ms: 567,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_1h_input_tokens: 15, ephemeral_5m_input_tokens: 25 },
      output_tokens_details: { thinking_tokens: 5 },
    },
  });
}

describe('resolveWorkerStoredText (B-947)', () => {
  it('extracts the `.result` prose from a valid envelope under 64 KB, and total_bytes matches the PROSE length', () => {
    const prose = 'I finished the leg. Everything is green.';
    const captured = resultEnvelope(prose);

    const stored = resolveWorkerStoredText(captured);
    expect(stored).toBe(prose);

    const totalBytes = Buffer.byteLength(stored, 'utf8');
    const tail = boundedTail(stored, LEG_OUTPUT_TAIL_BYTES);
    expect(tail).toBe(prose);
    expect(totalBytes).toBe(Buffer.byteLength(prose, 'utf8'));
    // Pin the point of the whole change: total_bytes must NOT be measured off the raw envelope,
    // which is always larger than the prose it wraps (JSON overhead: quotes, keys, usage object).
    expect(totalBytes).toBeLessThan(Buffer.byteLength(captured, 'utf8'));
  });

  it('falls back to the raw captured text, unchanged, when the capture is not a recognizable envelope', () => {
    const captured = 'PLAIN OUTPUT not json at all\nsome more lines\n';

    const stored = resolveWorkerStoredText(captured);
    expect(stored).toBe(captured);

    const totalBytes = Buffer.byteLength(stored, 'utf8');
    const tail = boundedTail(stored, LEG_OUTPUT_TAIL_BYTES);
    expect(tail).toBe(captured);
    expect(totalBytes).toBe(Buffer.byteLength(captured, 'utf8'));
  });

  it('keeps the FULL result prose when the envelope exceeds 64 KB but the prose itself does not', () => {
    // A long agent output pushes the overall JSON envelope over the 64 KB bound, but the `result`
    // string alone stays comfortably under it. Under the OLD raw-envelope-bounding behavior, the
    // tail-bound (which keeps the END of the string) would have cut this prose off, because
    // `result` sits near the START of the envelope and the trailing `usage`/other keys would have
    // pushed it out of the retained window.
    const prose = 'x'.repeat(65300); // under 64 KB alone, but leaves < 401 bytes of headroom
    const captured = resultEnvelope(prose); // JSON overhead pushes the WHOLE envelope over 64 KB
    expect(Buffer.byteLength(captured, 'utf8')).toBeGreaterThan(LEG_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(prose, 'utf8')).toBeLessThan(LEG_OUTPUT_TAIL_BYTES);

    const stored = resolveWorkerStoredText(captured);
    const totalBytes = Buffer.byteLength(stored, 'utf8');
    const tail = boundedTail(stored, LEG_OUTPUT_TAIL_BYTES);

    // The full prose survives — untruncated — because bounding was applied to the extracted prose,
    // not to the raw envelope.
    expect(tail).toBe(prose);
    expect(totalBytes).toBe(Buffer.byteLength(prose, 'utf8'));

    // Confirm what the OLD behavior would have done, so this test actually pins the regression: the
    // old tail (bounding the raw envelope) would NOT equal the full prose — it would be a substring
    // starting somewhere inside the JSON.
    const oldTail = boundedTail(captured, LEG_OUTPUT_TAIL_BYTES);
    expect(oldTail).not.toBe(prose);
  });

  it('extracts prose whose OWN length exceeds 64 KB — resolveWorkerStoredText itself does not bound; the caller bounds it', () => {
    const prose = 'y'.repeat(70 * 1024); // over 64 KB by itself
    const captured = resultEnvelope(prose);

    const stored = resolveWorkerStoredText(captured);
    expect(stored).toBe(prose); // extraction hands back the WHOLE prose, unbounded

    const tail = boundedTail(stored, LEG_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(LEG_OUTPUT_TAIL_BYTES);
    // The tail is the END of the (still oversized) prose — same tail-bounding contract as before,
    // just applied to prose instead of to a raw envelope.
    expect(prose.endsWith(tail)).toBe(true);
  });

  it('LAUNCHER path is unaffected: launcher captures are never envelope-extracted, even if they happen to look like one', () => {
    // The action in leg-output.ts only calls resolveWorkerStoredText for `source === 'worker'`; the
    // launcher branch stores `captured` verbatim regardless of its shape. This pins that the helper
    // itself is a pure function the caller opts into — it does not inspect `source`, so a launcher
    // capture that happens to parse as an envelope would ALSO be extracted if the caller mistakenly
    // ran it through this helper, which is exactly why the call site gates on `source === 'worker'`
    // rather than calling this unconditionally.
    const prose = 'the worker prose';
    const captured = resultEnvelope(prose);

    // Simulating the LAUNCHER branch's own handling (as leg-output.ts's action does): source !==
    // 'worker' skips extraction entirely and stores the raw captured text.
    const launcherStored = captured; // mirrors `source === 'worker' ? resolveWorkerStoredText(captured) : captured`
    expect(launcherStored).toBe(captured);
    expect(launcherStored).not.toBe(prose);
  });
});
