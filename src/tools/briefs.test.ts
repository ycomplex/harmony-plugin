import { describe, it, expect, vi } from 'vitest';
import { renderBrief, lintBrief, composeBrief, getBrief, resolveBrief, type BriefDoc, type BriefItem } from './briefs.js';

const decision = (over: Partial<BriefItem> = {}): BriefItem => ({
  kind: 'decision', text: 'Pick sidebar placement', recommendation: 'Sub-section under project views', ...over,
});

const baseDoc = (over: Partial<BriefDoc> = {}): BriefDoc => ({
  decide: 'Saved views — sidebar placement.',
  recommend: { text: 'Sub-section under project views.' },
  why: ['Sidebar is where users navigate views'],
  items: [decision()],
  ...over,
});

describe('renderBrief', () => {
  it('renders the BLUF skeleton: DECIDE, Recommend, Why, You need to, tail', () => {
    const md = renderBrief(baseDoc());
    expect(md).toContain('## DECIDE: Saved views — sidebar placement.');
    expect(md).toContain('**Recommend:** Sub-section under project views.');
    expect(md).toContain('**Why:**');
    expect(md).toContain('- Sidebar is where users navigate views');
    expect(md).toContain('**You need to:**');
    expect(md).toContain('- [ ] Pick sidebar placement — *recommend: Sub-section under project views*');
    expect(md).toContain('> Type `accept`, `edit`, `iterate <feedback>`, or `defer`.');
  });

  it('renders the cede suffix for a values call', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', cede: true } }));
    expect(md).toContain('**Recommend (low confidence — this is a values call you should own):** Option A');
  });

  it('renders content-input items as a request, not a recommended fork', () => {
    const md = renderBrief(baseDoc({ items: [{ kind: 'content-input', text: 'Provide the survey questions' }] }));
    expect(md).toContain('- [ ] Provide the survey questions *(your input needed)*');
  });

  it('renders research-first when a load-bearing gap is declared', () => {
    const md = renderBrief(baseDoc({
      recommend: undefined, load_bearing_gap: true,
      research: ['What is the GDPR retention limit?'], items: [decision({ deferred: true })],
    }));
    expect(md).toContain("I don't know enough yet");
    expect(md).toContain('**Research first:**');
    expect(md).toContain('1. What is the GDPR retention limit?');
  });
});

describe('lintBrief', () => {
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));

  it('passes a well-formed decision brief', () => {
    const r = lint(baseDoc());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags a naked fork: a decision item with no recommendation', () => {
    const r = lint(baseDoc({ items: [decision({ recommendation: '' })] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/naked fork/i);
  });

  it('flags a derived constraint asked as an actionable item', () => {
    const r = lint(baseDoc({ items: [decision(), { kind: 'derived-constraint', text: 'Confirm confidentiality rule applies' }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/derived constraint.*move it to Context/i);
  });

  it('accepts a content-input item without faking a recommendation', () => {
    const r = lint(baseDoc({ items: [decision(), { kind: 'content-input', text: 'Provide the survey questions' }] }));
    expect(r.ok).toBe(true);
  });

  it('errors when a load-bearing gap is declared but no research is supplied', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: [], items: [decision({ deferred: true })] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/no research/i);
  });

  it('errors when a load-bearing gap still asks a substantive (un-deferred) decision', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision()] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/defer the recommendation/i);
  });

  it('passes a research-first brief: gap declared, research supplied, decision deferred', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision({ deferred: true })] }));
    expect(r.ok).toBe(true);
  });

  it('warns (does not fail) when the rendered brief exceeds the soft word budget', () => {
    const r = lint(baseDoc({ why: [Array.from({ length: 350 }, (_, i) => `w${i}`).join(' ')] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget/i);
  });
});

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

// A chainable supabase mock whose terminal methods (single/maybeSingle) and direct `await` pop a queued
// response in call order. `then` makes the builder awaitable for the trailing tasks-update.
function makeClient(responses: Array<{ data: unknown; error?: unknown }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'is']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(next());
  return chain;
}

const okDoc = { decide: 'x', recommend: { text: 'y' }, items: [{ kind: 'decision', text: 'Pick', recommendation: 'A' }] };

describe('composeBrief', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 1 };

  it('renders + lints, validates pending_activity, inserts, then sets awaiting_human_input', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Idea' } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      pending_activity: 'clarifying', decision_ref: { type: 'decision', id: 'dec-1' },
    });
    expect(result.brief).toEqual(briefRow);
    expect(result.lint.ok).toBe(true);
    // content is derived (rendered), not passed in
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'task-1', reason: 'clarification-draft', content: expect.stringContaining('## DECIDE: x'),
    }));
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({
      awaiting_human_input: true, awaiting_human_reason: 'clarification-draft',
      awaiting_human_ref: { type: 'brief', id: 'brief-1' },
    }));
  });

  it('updates the active brief IN PLACE (iterate) and bumps iteration (no pending_activity guard)', async () => {
    // no pending_activity -> guard skipped. responses: [active found] -> [update row] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: { ...briefRow, iteration: 2 } }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }));
    expect((result.brief as any).iteration).toBe(2);
  });

  it('throws on a lint failure (naked fork) before any DB write', async () => {
    const client = makeClient([]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft',
        doc: { decide: 'x', items: [{ kind: 'decision', text: 'Pick' }] } as any, // no recommendation
      }),
    ).rejects.toThrow(/pre-send lint/i);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('throws when pending_activity has no transition from the current state', async () => {
    // responses: [task state] -> [transition lookup returns null]
    const client = makeClient([{ data: { workflow_state: 'Built' } }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
      }),
    ).rejects.toThrow(/no valid transition/i);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('rejects an unknown reason', async () => {
    const client = makeClient([]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, { task_id: 't', reason: 'bogus' as any, doc: okDoc as any }),
    ).rejects.toThrow(/reason/i);
  });
});

describe('getBrief', () => {
  it('returns the active brief for a task', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    const client = makeClient([{ data: row }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(client.from).toHaveBeenCalledWith('briefs');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(result).toEqual(row);
  });
});

describe('resolveBrief', () => {
  function makeRpcClient(active: unknown, rpcResult: unknown) {
    const chain: any = {};
    for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: active, error: null }));
    chain.rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return chain;
  }

  it('looks up the (unique) active brief then calls the resolve_brief RPC for accept', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_id: 'brief-1', workflow_state: 'Clarified', brief_status: 'accepted' });
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'accept', _detail: null });
    expect(result).toEqual({ brief_id: 'brief-1', workflow_state: 'Clarified', brief_status: 'accepted' });
  });

  it('passes the detail through for defer', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_status: 'deferred' });
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', detail: 'later' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'defer', _detail: 'later' });
  });

  it('rejects commands other than accept/defer', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, {});
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'iterate' as any }))
      .rejects.toThrow(/only accept\/defer/i);
  });

  it('throws when there is no active brief', async () => {
    const client = makeRpcClient(null, {});
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' }))
      .rejects.toThrow(/no active brief/i);
  });
});
