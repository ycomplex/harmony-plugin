// B-720 (replacement capture): unit coverage for the leg-output shared-core accessors — above all,
// that the WRITE NEVER THROWS. That is not a nicety: harmony-web's `conduction_leg_output` migration
// promotes on its own schedule, so between this plugin merging and that promotion every insert here
// is rejected by PostgREST with a table-absent error. A thrown error would ride out of the CLI
// accessor into container/provision.sh's `set -euo pipefail` script and fail the leg — or, on the
// daemon's side, out of `flushLaunchOutput` and strand a settling conduction. A diagnostic nicety
// must never kill the run it was meant to describe.

import { describe, it, expect, vi } from 'vitest';
import {
  recordLegOutput,
  listLegOutput,
  boundedTail,
  LEG_OUTPUT_TAIL_BYTES,
} from './leg-output-record.js';

/** A chainable supabase mock, same shape as leg-cost-record.test.ts's makeClient: terminal methods
 *  pop a queued response in call order. `insert` is terminal here (recordLegOutput awaits the
 *  builder directly — no trailing .select()), so the chain is thenable. */
function makeClient(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = { calls: [] as Array<{ method: string; args: unknown[] }> };
  for (const m of ['from', 'select', 'insert', 'eq', 'order']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      chain.calls.push({ method: m, args });
      return chain;
    });
  }
  chain.maybeSingle = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => void) => resolve(next());
  return chain;
}

/** A client whose every call explodes — the "not even a PostgrestError, the client itself is
 *  broken" case. */
function throwingClient() {
  const chain: any = {};
  chain.from = vi.fn(() => {
    throw new Error('kaboom');
  });
  return chain;
}

const TABLE_ABSENT = {
  code: '42P01',
  message: 'relation "public.conduction_leg_output" does not exist',
};

const insertedRow = (client: any): Record<string, unknown> =>
  client.calls.find((c: any) => c.method === 'insert')!.args[0] as Record<string, unknown>;

describe('recordLegOutput', () => {
  it('inserts ONE row carrying the producer label, the tail, the total and the leg key', async () => {
    const client = makeClient([{ error: null }]);
    const ok = await recordLegOutput(client, {
      conduction_id: 'cond-1',
      source: 'worker',
      leg_key: 'leg-1',
      task_id: 'task-1',
      gate: 'build',
      tail: 'the last 64 KB',
      total_bytes: 70000,
    });

    expect(ok).toBe(true);
    expect(client.from).toHaveBeenCalledWith('conduction_leg_output');
    expect(insertedRow(client)).toEqual({
      conduction_id: 'cond-1',
      task_id: 'task-1',
      leg_key: 'leg-1',
      source: 'worker',
      tail: 'the last 64 KB',
      total_bytes: 70000,
      gate: 'build',
    });
  });

  it('omits captured_at entirely unless the caller owns a clock — the column default must stamp it', async () => {
    const client = makeClient([{ error: null }]);
    await recordLegOutput(client, { conduction_id: 'cond-1', source: 'worker', tail: 'x' });
    // A null here would violate the column's NOT NULL and lose the row.
    expect('captured_at' in insertedRow(client)).toBe(false);

    const withClock = makeClient([{ error: null }]);
    await recordLegOutput(withClock, {
      conduction_id: 'cond-1',
      source: 'launcher',
      tail: 'x',
      captured_at: '2026-09-04T11:00:00.000Z',
    });
    expect(insertedRow(withClock).captured_at).toBe('2026-09-04T11:00:00.000Z');
  });

  it('stores an EMPTY tail as NULL — "" and "nothing captured" must not render differently', async () => {
    const client = makeClient([{ error: null }]);
    await recordLegOutput(client, {
      conduction_id: 'cond-1',
      source: 'launcher',
      tail: '',
      total_bytes: 0,
    });
    expect(insertedRow(client).tail).toBeNull();
    // The total is still recorded as the honest 0 — the launch DID settle here.
    expect(insertedRow(client).total_bytes).toBe(0);
  });

  it('writes a null leg_key for a launcher row — the daemon cannot know the worker-minted key', async () => {
    const client = makeClient([{ error: null }]);
    await recordLegOutput(client, { conduction_id: 'cond-1', source: 'launcher', tail: 'chatter' });
    expect(insertedRow(client).leg_key).toBeNull();
  });

  it('NEVER THROWS when the table does not exist yet, and says so in ONE stderr warning', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: TABLE_ABSENT }]);

    await expect(
      recordLegOutput(client, { conduction_id: 'cond-1', source: 'worker', tail: 'x' }),
    ).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EXPECTED');
    expect(String(warn.mock.calls[0][0])).toContain('the leg itself is unaffected');
    warn.mockRestore();
  });

  it('NEVER THROWS when the client itself explodes', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordLegOutput(throwingClient(), { conduction_id: 'cond-1', source: 'worker', tail: 'x' }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('SKIPS silently with no client and with no conduction id — neither is a failure', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordLegOutput(null, { conduction_id: 'cond-1', source: 'worker' })).resolves.toBe(false);
    await expect(
      recordLegOutput(makeClient([{ error: null }]), { conduction_id: '', source: 'worker' }),
    ).resolves.toBe(false);
    // A manual/dogfood container run is an ordinary shape, not something to warn about.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('boundedTail', () => {
  it('returns short text untouched — nothing to say about truncation', () => {
    expect(boundedTail('hello', 64)).toBe('hello');
    expect(boundedTail('', 64)).toBe('');
  });

  it('keeps the LAST bytes, within the bound', () => {
    const text = 'abcdefghij';
    expect(boundedTail(text, 4)).toBe('ghij');
    expect(Buffer.byteLength(boundedTail(text, 4), 'utf8')).toBeLessThanOrEqual(4);
  });

  it('never splits a multi-byte codepoint in half', () => {
    // Four 3-byte characters (12 bytes) bounded to 7 bytes: two whole characters fit, and the cut
    // lands on a character boundary rather than emitting a replacement char.
    const text = '日本語だ';
    const cut = boundedTail(text, 7);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(7);
    expect(cut).toBe('語だ');
    expect(cut).not.toContain('�');
  });

  it('defaults to the 64 KB bound the daemon has always used', () => {
    expect(LEG_OUTPUT_TAIL_BYTES).toBe(64 * 1024);
    const big = 'x'.repeat(LEG_OUTPUT_TAIL_BYTES + 500);
    expect(boundedTail(big).length).toBe(LEG_OUTPUT_TAIL_BYTES);
    // The tail, not the head: the END of a run is what an operator needs.
    expect(boundedTail(`HEAD${'x'.repeat(LEG_OUTPUT_TAIL_BYTES)}TAIL`).endsWith('TAIL')).toBe(true);
  });
});

describe('listLegOutput', () => {
  it('reads one conduction newest-first, optionally narrowed to ONE source', async () => {
    const client = makeClient([{ data: [{ id: 'row-1' }], error: null }]);
    const rows = await listLegOutput(client, { conduction_id: 'cond-1', source: 'worker' });

    expect(rows).toEqual([{ id: 'row-1' }]);
    expect(client.eq).toHaveBeenCalledWith('conduction_id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('source', 'worker');
    expect(client.order).toHaveBeenCalledWith('captured_at', { ascending: false });
  });

  it('degrades to [] on a table-absent read, never throwing', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ data: null, error: TABLE_ABSENT }]);
    await expect(listLegOutput(client, { conduction_id: 'cond-1' })).resolves.toEqual([]);
    await expect(listLegOutput(throwingClient(), { conduction_id: 'cond-1' })).resolves.toEqual([]);
    warn.mockRestore();
  });
});
