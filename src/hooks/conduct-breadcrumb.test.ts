import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConductBreadcrumb } from './conduct-breadcrumb.js';

const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); homes.forEach(p => rmSync(p, { recursive: true, force: true })); homes.length = 0; });
const input = { task: 'a8193a21-b2ad-42b5-b464-59579691931d', ticket: 'B-1440', sessionId: 'session-1' };
describe('code-written per-leg breadcrumb', () => {
  it('stamps fresh and resumed legs from the clock and leaves only complete JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'breadcrumb-')); homes.push(home);
    vi.useFakeTimers(); vi.setSystemTime('2026-11-10T15:18:35Z');
    const path = writeConductBreadcrumb(input, { home });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ session_id: input.sessionId, task_id: input.task, ticket: input.ticket, started_at: '2026-11-10T15:18:35.000Z' });
    vi.setSystemTime('2026-11-10T15:40:00Z');
    writeConductBreadcrumb(input, { home });
    expect(JSON.parse(readFileSync(path, 'utf8')).started_at).toBe('2026-11-10T15:40:00.000Z');
    expect(readdirSync(join(home, 'conduct-sessions'))).toEqual(['session-1.json']);
  });
  it.each(['../escape', '/absolute', 'a/b', '.', 'a\nline'])('refuses unsafe session %j before writing', sessionId => {
    expect(() => writeConductBreadcrumb({ ...input, sessionId })).toThrow('Invalid conduct identity');
  });
});
