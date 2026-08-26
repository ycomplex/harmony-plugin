// B-740: `request_conduction_reap` — the MCP tool test suite. Mirrors create-conduction.test.ts's
// mocking convention: the conduction-record primitives (getConduction, updateConduction) are mocked
// so this suite pins ONLY the tool's own contract (existence check, the exact patch shape, the
// never-kills-directly message) — never conduction-record.ts's own DB-write mechanics (that module's
// own test file owns that).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestConductionReap, requestConductionReapTool } from './request-conduction-reap.js';

const mocks = vi.hoisted(() => ({
  getConduction: vi.fn(),
  updateConduction: vi.fn(),
}));

vi.mock('./conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conduction-record.js')>();
  return {
    ...actual,
    getConduction: mocks.getConduction,
    updateConduction: mocks.updateConduction,
  };
});

const client = { fake: 'client' } as never;

const existingRow = {
  id: 'cond-1',
  task_id: 'task-1',
  status: 'active',
  reap_requested_at: null,
};

const patchedRow = { ...existingRow, reap_requested_at: '2026-08-26T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConduction.mockResolvedValue(existingRow);
  mocks.updateConduction.mockResolvedValue(patchedRow);
});

describe('requestConductionReap (request_conduction_reap MCP tool handler)', () => {
  it('looks up the conduction, then patches ONLY reap_requested_at to an ISO now() timestamp', async () => {
    const result = await requestConductionReap(client, { conduction_id: 'cond-1' });

    expect(mocks.getConduction).toHaveBeenCalledWith(client, 'cond-1');
    expect(mocks.updateConduction).toHaveBeenCalledTimes(1);
    const [passedClient, passedId, patch] = mocks.updateConduction.mock.calls[0];
    expect(passedClient).toBe(client);
    expect(passedId).toBe('cond-1');
    expect(Object.keys(patch)).toEqual(['reap_requested_at']);
    expect(typeof patch.reap_requested_at).toBe('string');
    expect(new Date(patch.reap_requested_at).toISOString()).toBe(patch.reap_requested_at);

    expect(result.conduction).toEqual(patchedRow);
    expect(result.message).toMatch(/reap requested/i);
    // Never claims to have performed the kill itself — this call only ever flags the row.
    expect(result.message).toMatch(/never kill/i);
  });

  it('requires conduction_id', async () => {
    await expect(requestConductionReap(client, { conduction_id: '' })).rejects.toThrow(
      /conduction_id is required/,
    );
    expect(mocks.getConduction).not.toHaveBeenCalled();
  });

  it('refuses cleanly when the conduction does not exist — never a raw null-deref', async () => {
    mocks.getConduction.mockResolvedValue(null);
    await expect(requestConductionReap(client, { conduction_id: 'cond-missing' })).rejects.toThrow(
      /not found/i,
    );
    expect(mocks.updateConduction).not.toHaveBeenCalled();
  });
});

describe('requestConductionReapTool (schema)', () => {
  it('names conduction_id as the sole required input', () => {
    expect(requestConductionReapTool.name).toBe('request_conduction_reap');
    expect(requestConductionReapTool.inputSchema.required).toEqual(['conduction_id']);
    expect(Object.keys(requestConductionReapTool.inputSchema.properties)).toEqual(['conduction_id']);
  });
});
