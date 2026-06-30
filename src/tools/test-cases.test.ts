import { describe, it, expect, vi, beforeEach } from 'vitest';
import { manageTestCases } from './test-cases.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
}));

// A chainable mock of the Supabase client for the `test_cases` table. It satisfies
// two shapes used by manageTestCases:
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
              data: rows.map((r: any, i: number) => ({ ...r, id: `tc-${i}` })),
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
                    data: { id: 'tc-1', ...payload },
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

describe('manageTestCases — type validation against the DB constraint', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('AC2: inserts add rows with a valid type and returns them', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: 2 });

    const result = await manageTestCases(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [
        { name: 'login works', type: 'e2e' },
        { name: 'reducer returns state', type: 'unit' },
      ],
    });

    // The insert was attempted with the valid types preserved.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const rows = insertSpy.mock.calls[0][0];
    expect(rows.map((r: any) => r.type)).toEqual(['e2e', 'unit']);
    // Positions continue from the existing max (2) → 3, 4.
    expect(rows.map((r: any) => r.position)).toEqual([3, 4]);
    // The added rows (with ids) are returned.
    expect(result.added).toHaveLength(2);
    expect(result.added[0]).toMatchObject({ name: 'login works', type: 'e2e', id: 'tc-0' });
  });

  it('accepts the third valid type: integration', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy, maxPosition: -1 });

    const result = await manageTestCases(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ name: 'api round-trip', type: 'integration' }],
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(result.added[0]).toMatchObject({ type: 'integration', position: 0 });
  });

  it('AC3: rejects an invalid type ("manual") on add with a clear error and no insert', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy });

    await expect(
      manageTestCases(client, 'proj-1', 'user-1', {
        task_id: 'B-1',
        add: [{ name: 'old-style', type: 'manual' }],
      }),
    ).rejects.toThrow(/must be one of: unit, e2e, integration/);

    // No raw Postgres 23514 — the guard fired before any DB call.
    expect(insertSpy).not.toHaveBeenCalled();
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('AC4: rejects an omitted type on add with a clear error and no insert', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy });

    await expect(
      manageTestCases(client, 'proj-1', 'user-1', {
        task_id: 'B-1',
        add: [{ name: 'no type given' } as any],
      }),
    ).rejects.toThrow(/must be one of: unit, e2e, integration/);

    // No raw Postgres 23502 — fails fast on validation.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('validates every add row before inserting (a later bad row blocks the whole batch)', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy });

    await expect(
      manageTestCases(client, 'proj-1', 'user-1', {
        task_id: 'B-1',
        add: [
          { name: 'good', type: 'unit' },
          { name: 'bad', type: 'manual' },
        ],
      }),
    ).rejects.toThrow(/must be one of/);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects an update with an invalid type and does not run the update', async () => {
    const updateSpy = vi.fn();
    const client = makeClient({ updateSpy });

    await expect(
      manageTestCases(client, 'proj-1', 'user-1', {
        task_id: 'B-1',
        update: [{ id: 'tc-xyz', type: 'manual' }],
      }),
    ).rejects.toThrow(/must be one of: unit, e2e, integration/);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('applies an update with a valid type', async () => {
    const updateSpy = vi.fn();
    const client = makeClient({ updateSpy });

    const result = await manageTestCases(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      update: [{ id: 'tc-xyz', type: 'integration', name: 'renamed' }],
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ type: 'integration', name: 'renamed' });
    expect(result.updated[0]).toMatchObject({ type: 'integration' });
  });
});
