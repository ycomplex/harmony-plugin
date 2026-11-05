import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { refreshAfterCompletingAccept } from './project-context-consumer.js';
const ports = vi.hoisted(() => ({ task: vi.fn(), read: vi.fn(), refresh: vi.fn() }));
vi.mock('./tasks.js', () => ({ getTask: ports.task }));
vi.mock('./project-context.js', async original => ({ ...await original<typeof import('./project-context.js')>(), readProjectContext: ports.read }));
vi.mock('./project-context-file.js', () => ({ refreshProjectContextFile: ports.refresh }));
it.each(['2026-11-02T17:38:20Z', '2026-11-02T17:38:22Z'])('after-accept with commit at %s replays the legacy payload-only human completion and refuses an agent accept', async committedAt => {
  ports.task.mockResolvedValue({ id: 'ticket', title: 'Decide the architecture', workflow_state: 'Verified', labels: [{ name: 'inception-scaffold' }, { name: 'decision-only' }] });
  const snapshot = { blocks: [], diagnostics: [] }; ports.read.mockResolvedValue(snapshot); ports.refresh.mockResolvedValue({ changed: false });
  let provenance = 'human-in-session';
  const client = { from: (table: string) => {
    const q = { select: () => q, eq: () => q, order: () => q, range: () => q,
      maybeSingle: async () => ({ error: null, data: { id: 'brief', reason: 'design-decision-draft', doc: { frame: {}, payload: [{ write_kind: 'knowledge_entry_content', entry_id: 'decision' }] } } }),
      then: (done: (value: unknown) => unknown) => Promise.resolve(done({ error: null, data: table === 'activity_events' ? [
        { created_at: '2026-11-02T17:38:20Z', event_type: 'brief_resolved', metadata: { brief_id: 'brief', command: 'accept', provenance } },
        { created_at: committedAt, event_type: 'field_change', field_name: 'workflow_state', old_value: 'Decomposed', new_value: 'Designed' },
        { created_at: committedAt, event_type: 'acceptance_event_consumed', field_name: 'workflow_state', old_value: 'Decomposed', new_value: 'Designed' },
        { created_at: '2026-11-02T17:38:24Z', event_type: 'field_change', field_name: 'workflow_state', old_value: 'Designed', new_value: 'Verified' },
      ] : [] })),
    }; return q;
  } } as unknown as SupabaseClient;
  expect(await refreshAfterCompletingAccept(client, 'project', 'user', 'ticket', '/repo')).toMatchObject({ status: 'refreshed' });
  expect(ports.refresh).toHaveBeenCalledWith('/repo', snapshot);
  ports.refresh.mockClear(); provenance = 'agent-synthesized:override';
  expect(await refreshAfterCompletingAccept(client, 'project', 'user', 'ticket', '/repo')).toMatchObject({ status: 'not-applicable' });
  expect(ports.refresh).not.toHaveBeenCalled();
});
