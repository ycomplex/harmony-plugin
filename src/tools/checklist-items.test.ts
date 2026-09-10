import { describe, it, expect, vi, beforeEach } from 'vitest';
import { manageChecklistItems } from './checklist-items.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
}));

// A chainable mock of the Supabase client for the `checklist_items` table. Mirrors
// test-cases.test.ts's makeClient — the shared pattern for these positional list-item tools:
//   - position lookup: .select('position').eq().order().limit()  → resolves with maxRow
//   - insert:          .insert(rows).select()                     → resolves with the rows + ids
//   - update:          .update(payload).eq().eq().select().single()
function makeClient(opts: {
  insertSpy?: ReturnType<typeof vi.fn>;
  updateSpy?: ReturnType<typeof vi.fn>;
  maxPosition?: number;
} = {}) {
  return {
    from: vi.fn(() => {
      const selectChain: any = {
        eq: () => selectChain,
        order: () => selectChain,
        limit: vi.fn().mockResolvedValue({
          data: opts.maxPosition === undefined ? [] : [{ position: opts.maxPosition }],
          error: null,
        }),
      };
      return {
        select: () => selectChain,
        insert: (rows: any[]) => {
          opts.insertSpy?.(rows);
          return {
            select: vi.fn().mockResolvedValue({
              data: rows.map((r: any, i: number) => ({ ...r, id: `ci-${i}` })),
              error: null,
            }),
          };
        },
        update: (payload: any) => {
          opts.updateSpy?.(payload);
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'ci-1', ...payload },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        },
      };
    }),
  } as any;
}

describe('manageChecklistItems — HTML entity normalization (B-993)', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('decodes a mangled entity in an added item\'s title', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: -1 });

    const result = await manageChecklistItems(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ title: 'Fix &quot;Save &amp; Continue&quot; button' }],
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0][0].title).toBe('Fix "Save & Continue" button');
    expect(result.added[0].title).toBe('Fix "Save & Continue" button');
  });

  it('decodes a mangled entity in an updated item\'s title', async () => {
    const updateSpy = vi.fn();
    const client = makeClient({ updateSpy });

    await manageChecklistItems(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      update: [{ id: 'ci-1', title: 'A &lt; B check' }],
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].title).toBe('A < B check');
  });

  it('leaves a code-span entity untouched in an added item\'s title', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: -1 });

    await manageChecklistItems(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ title: 'Renders `Tom &amp; Jerry` literally in the fixture' }],
    });

    expect(insertSpy.mock.calls[0][0][0].title).toBe('Renders `Tom &amp; Jerry` literally in the fixture');
  });
});
