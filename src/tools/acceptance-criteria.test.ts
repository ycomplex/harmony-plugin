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

// B-1034 AC C — harmony-design-decide's SHARPEN/drop branch stays fully manual (the ledger never
// auto-applies a mixed ADD+update payload — see acceptance-events.test.ts's companion "AC C" describe
// block for that half of the proof). This half proves the MANUAL side: a single `manage_acceptance_criteria`
// call carrying BOTH an `add` and an `update` in the SAME call inserts exactly ONE new row and updates
// exactly ONE existing row — never a doubled ADD.
describe('manageAcceptanceCriteria — B-1034 AC C: one ADD + one SHARPEN in the same call never doubles the ADD', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('add:[one] + update:[one] in ONE call inserts exactly one row and updates exactly one row', async () => {
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const client = makeClient({ insertSpy, updateSpy, maxPosition: 2 });

    const result = await manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ content: 'A genuinely new design-dependent AC' }],
      update: [{ id: 'ac-existing-1', content: 'Sharpened happy-path AC text' }],
    });

    // Exactly one insert CALL, carrying exactly one row — never two adds, never the update re-expressed
    // as a second add.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toHaveLength(1);
    expect(insertSpy.mock.calls[0][0][0].content).toBe('A genuinely new design-dependent AC');
    expect(result.added).toHaveLength(1);

    // Exactly one update call — never a second insert standing in for it.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].content).toBe('Sharpened happy-path AC text');
    expect(result.updated).toHaveLength(1);
  });
});

// B-1400: undocumented arguments (top-level, and keys inside add[i] / update[i]) are refused before
// any client call — `items` instead of `add` used to return a silent `{ added: [] }` success.
describe('manageAcceptanceCriteria — B-1400 refuses unknown arguments', () => {
  let resolveMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('refuses `items` by name, before resolveTaskId and with no client call', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy });

    await expect(
      manageAcceptanceCriteria(client, 'proj-1', 'user-1', { task_id: 'B-1', items: [{ content: 'a' }] } as any),
    ).rejects.toThrow(
      'manage_acceptance_criteria does not accept: items. Accepted arguments: task_id, add, update, delete.',
    );
    expect(resolveMock).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('refuses an unknown add entry key as add[0].text', async () => {
    const insertSpy = vi.fn();
    const client = makeClient({ insertSpy });

    await expect(
      manageAcceptanceCriteria(client, 'proj-1', 'user-1', { task_id: 'B-1', add: [{ text: 'x' }] } as any),
    ).rejects.toThrow(/does not accept: add\[0\]\.text\./);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('refuses an unknown update entry key as update[1].met', async () => {
    const client = makeClient();

    await expect(
      manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
        task_id: 'B-1',
        update: [{ id: 'a', checked: true }, { id: 'b', met: true }],
      } as any),
    ).rejects.toThrow(/does not accept: update\[1\]\.met\. Accepted arguments: .*\nEach update entry accepts: id, content, checked\./);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('documented add and update still work', async () => {
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const client = makeClient({ insertSpy, updateSpy, maxPosition: 0 });

    const result = await manageAcceptanceCriteria(client, 'proj-1', 'user-1', {
      task_id: 'B-1',
      add: [{ content: 'New', checked: false }],
      update: [{ id: 'ac-1', content: undefined, checked: true }],
    });

    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({ content: 'New', checked: false, position: 1 });
    expect(updateSpy.mock.calls[0][0]).toEqual({ checked: true });
    expect(result.added).toHaveLength(1);
    expect(result.updated).toHaveLength(1);
  });

  it('documented delete still works', async () => {
    const inSpy = vi.fn();
    const client = {
      from: vi.fn(() => ({
        delete: () => ({
          in: (col: string, ids: string[]) => {
            inSpy(col, ids);
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          },
        }),
      })),
    } as any;

    const result = await manageAcceptanceCriteria(client, 'proj-1', 'user-1', { task_id: 'B-1', delete: ['ac-9'] });

    expect(inSpy).toHaveBeenCalledWith('id', ['ac-9']);
    expect(result.deleted).toEqual(['ac-9']);
  });
});
