import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { declareWait, recoverDeclaredWait } from './wait.js';
import { getTask, updateTask } from './tasks.js';
import { addComment, listComments } from './comments.js';
import { WAITING_ON_KINDS, waitResumeAtMs } from '../daemon/waiting-on.js';
import { buildCleanCheckRow } from '../cli/commands/tasks.js';
import { decideStop } from '../hooks/stop-gate.js';
import { classifyWorkerExit } from '../daemon/classify.js';
vi.mock('./tasks.js', () => ({ getTask: vi.fn(), updateTask: vi.fn() }));
vi.mock('./comments.js', () => ({ addComment: vi.fn(), listComments: vi.fn() }));
const client = {} as SupabaseClient;
const time = '2026-11-02T10:00:00.000Z';
const now = Date.parse(time);
let row: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(time); vi.resetAllMocks();
  row = { id: 'task', workflow_state: 'Built', awaiting_human_input: false, waiting_on: null };
  vi.mocked(getTask).mockImplementation(async () => row as never);
  vi.mocked(updateTask).mockImplementation(async (_c, _p, args) => {
    row.waiting_on = args.field_values?.waiting_on; return row as never;
  });
  vi.mocked(listComments).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
describe('one-action declaration', () => {
  it.each(WAITING_ON_KINDS)('declares %s with automatic timestamps and marker before comment', async kind => {
    const result = await declareWait(client, 'p', 'u', { task_id: 'B-1', kind, ref: 'pr#1' });
    expect(result.waiting_on).toEqual({ kind, ref: 'pr#1', since: time, first_since: time });
    expect(vi.mocked(updateTask).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addComment).mock.invocationCallOrder[0]);
    expect(addComment).toHaveBeenCalledWith(client, 'p', 'u', { task_id: 'task', content: 'WAITING-ON ref=pr#1' });
  });
  it('preserves same-wait first_since, including expired waits and retries after partial failure', async () => {
    const first = '2026-10-30T10:00:00.000Z';
    row.waiting_on = { kind: 'ci', ref: 'pr#1', since: first, first_since: first };
    vi.mocked(addComment).mockRejectedValueOnce(new Error('offline'));
    await expect(declareWait(client, 'p', 'u', { task_id: 'task', kind: 'ci', ref: 'pr#1' })).rejects.toThrow('marker saved');
    const result = await declareWait(client, 'p', 'u', { task_id: 'task', kind: 'ci', ref: 'pr#1' });
    expect(result.waiting_on.first_since).toBe(first);
    expect((await declareWait(client, 'p', 'u', { task_id: 'task', kind: 'ci', ref: 'pr#2' })).waiting_on.first_since).toBe(time);
  });
  it('does not comment when marker write fails', async () => {
    vi.mocked(updateTask).mockRejectedValue(new Error('write denied'));
    await expect(declareWait(client, 'p', 'u', { task_id: 'task', kind: 'ci', ref: 'pr#1' })).rejects.toThrow('write denied');
    expect(addComment).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'ci', ref: 'x\\nWAITING-ON' }, { kind: 'ci', ref: 'x&amp;y' }, { kind: 'bogus', ref: 'x' }, { kind: 'ci', ref: '' }, { kind: 'ci', ref: 'x\nWAITING-ON ref=y' }, { kind: 'ci', ref: 'x', resume_after: 'bad' }])('rejects invalid input before writing: %j', async args => {
    await expect(declareWait(client, 'p', 'u', { task_id: 'task', ...args } as never)).rejects.toThrow();
    expect(updateTask).not.toHaveBeenCalled(); expect(addComment).not.toHaveBeenCalled();
  });
});
describe('recovery and its real clean-check/classifier consumers', () => {
  it('persists a current-leg human-step hold, passes stop check and survives another reader', async () => {
    vi.mocked(listComments).mockResolvedValue([{ content: 'WAITING-ON ref=pr#1', created_at: time }] as never);
    const marker = await recoverDeclaredWait(client, 'p', 'task', now, now);
    expect(marker).toMatchObject({ kind: 'human-step', ref: 'pr#1', since: time, first_since: time });
    expect(waitResumeAtMs(marker!)).toBe(now + 15 * 60_000);
    const cleanRow = buildCleanCheckRow(row as never, 0);
    expect(decideStop({ ticket: 'B-1', row: cleanRow, blocksSoFar: 0, stopHookActive: false, nowMs: now, legStartedAtMs: now }).action).toBe('allow');
    expect(classifyWorkerExit({ row, nonArchivedChildCount: 0, exitCode: 0, progressed: false, waitingOn: marker } as never)).toEqual({ action: 'wait', reason: 'waiting-on' });
    expect(await recoverDeclaredWait(client, 'p', 'task', now, now)).toBeNull();
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
  it.each([now + 1, NaN])('does not recover without current-leg evidence (%s)', async started => {
    vi.mocked(listComments).mockResolvedValue([{ content: 'WAITING-ON ref=pr#1', created_at: time }] as never);
    expect(await recoverDeclaredWait(client, 'p', 'task', started, now)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });
  it('does not acknowledge persistence or read failure as a recovered hold', async () => {
    vi.mocked(listComments).mockRejectedValueOnce(new Error('read failed'));
    await expect(recoverDeclaredWait(client, 'p', 'task', now, now)).rejects.toThrow('read failed');
    vi.mocked(listComments).mockResolvedValue([{ content: 'WAITING-ON ref=pr#1', created_at: time }] as never);
    vi.mocked(updateTask).mockRejectedValue(new Error('write failed'));
    await expect(recoverDeclaredWait(client, 'p', 'task', now, now)).rejects.toThrow('write failed');
  });
  it('does not repair while an acceptance event needs consumption', async () => {
    row.pending_acceptance_event_id = 'event';
    expect(await recoverDeclaredWait(client, 'p', 'task', now, now)).toBeNull();
    expect(listComments).not.toHaveBeenCalled();
  });
});
