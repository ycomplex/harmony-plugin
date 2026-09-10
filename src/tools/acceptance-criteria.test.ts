import { describe, it, expect, vi, beforeEach } from 'vitest';
import { manageAcceptanceCriteria } from './acceptance-criteria.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
}));

// A chainable mock of the Supabase client for the `acceptance_criteria` table. Mirrors
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
              data: rows.map((r: any, i: number) => ({ ...r, id: `ac-${i}` })),
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
                    data: { id: 'ac-1', ...payload },
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

describe('manageAcceptanceCriteria — HTML entity normalization (B-993)', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('decodes a mangled entity in an added criterion\'s content', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: -1 });

    const result = await manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ content: 'Button reads &quot;Save &amp; Continue&quot;' }],
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0][0].content).toBe('Button reads "Save & Continue"');
    expect(result.added[0].content).toBe('Button reads "Save & Continue"');
  });

  it('decodes a mangled entity in an updated criterion\'s content', async () => {
    const updateSpy = vi.fn();
    const client = makeClient({ updateSpy });

    await manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      update: [{ id: 'ac-1', content: 'A &lt; B must hold' }],
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].content).toBe('A < B must hold');
  });

  it('leaves a code-span entity untouched in an added criterion\'s content', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: -1 });

    await manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ content: 'Renders `Tom &amp; Jerry` literally in the fixture' }],
    });

    expect(insertSpy.mock.calls[0][0][0].content).toBe('Renders `Tom &amp; Jerry` literally in the fixture');
  });
});
