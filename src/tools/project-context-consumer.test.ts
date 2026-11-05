import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeContextCompletion, isContextCompletingAccept } from './project-context-consumer.js';
import { refreshProjectContextFile } from './project-context-file.js';
import type { ProjectContext } from './project-context.js';
const snapshot: ProjectContext = { version: 1, project_id: 'fixture', project_name: 'Disposable', diagnostics: [], blocks: [
  { key: 'proposition', title: 'What this project is', ticket: 'FX-1', state: 'accepted', source_ids: ['source-1'], summary: 'Purpose: tokens. Personas: designers. Features: export.', diagnostics: [] },
] };
describe('completing-accept consumer', () => {
  it('uses B-1384 markers and human provenance; neither early tracks nor delegated accepts qualify', () => {
    const input = { workflow_state: 'Verified', labels: ['decision-only'], reason: 'design-decision-draft', provenance: 'human-in-browser', completion: { gate: 'design', to_state: 'Verified' } };
    expect(isContextCompletingAccept(input)).toBe(true);
    expect(isContextCompletingAccept({ ...input, provenance: 'agent-synthesized:orchestrator' })).toBe(false);
    expect(isContextCompletingAccept({ ...input, provenance: 'agent-synthesized:override' })).toBe(false);
    expect(isContextCompletingAccept({ ...input, workflow_state: 'Designed' })).toBe(false);
    expect(isContextCompletingAccept({ ...input, completion: undefined })).toBe(false);
    expect(isContextCompletingAccept({ ...input, labels: ['capture-only'] })).toBe(false);
    expect(isContextCompletingAccept({ ...input, labels: ['capture-only', 'decision-only'] })).toBe(false);
    expect(isContextCompletingAccept({ ...input, labels: ['capture-only'], reason: 'clarification-draft', completion: { gate: 'clarify', to_state: 'Verified' } })).toBe(true);
  });
  it('replays a browser completion in a fresh consumer without duplicating the file section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-replay-'));
    const reportOnce = vi.fn();
    try {
      const ports = { read: async () => snapshot, refresh: (value: ProjectContext) => refreshProjectContextFile(root, value), reportOnce };
      expect((await consumeContextCompletion('ticket', 'browser-brief', ports)).status).toBe('refreshed');
      const first = await readFile(join(root, 'CLAUDE.md'), 'utf8');
      await consumeContextCompletion('ticket', 'browser-brief', ports);
      expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(first);
      expect(reportOnce).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('leaves completed acceptance intact and reports source ids once when the repo is inaccessible', async () => {
    const comments = new Map<string, string>();
    const ports = { read: async () => snapshot, refresh: async () => { throw new Error('checkout unavailable'); },
      reportOnce: async (marker: string, content: string) => { if (!comments.has(marker)) comments.set(marker, content); } };
    expect(await consumeContextCompletion('ticket', 'brief', ports)).toMatchObject({ status: 'pending', source_ids: ['source-1'] });
    await consumeContextCompletion('ticket', 'brief', ports);
    expect(comments.size).toBe(1);
    expect([...comments.values()][0]).toContain('acceptance remains complete');
    expect([...comments.values()][0]).toContain('source-1');
  });
  it('reports read failures and preserves reporting failures as failures', async () => {
    const reportOnce = vi.fn();
    await consumeContextCompletion('ticket', 'brief', { read: async () => { throw new Error('source denied'); }, refresh: vi.fn(), reportOnce });
    expect(reportOnce.mock.calls[0][1]).toContain('source denied');
    await expect(consumeContextCompletion('ticket', 'brief', { read: async () => snapshot,
      refresh: async () => { throw new Error('repo absent'); }, reportOnce: async () => { throw new Error('comment denied'); } })).rejects.toThrow('comment denied');
  });
});
