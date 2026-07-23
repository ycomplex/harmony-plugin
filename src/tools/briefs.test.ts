import { describe, it, expect, vi } from 'vitest';
import { renderBrief, lintBrief, composeBrief, composeBriefTool, getBrief, resolveBrief, fetchPendingResolution, fetchPendingRemark, consumeAcceptRemark, SENTENCE_WORD_LIMIT, type BriefDoc, type BriefItem } from './briefs.js';

// Pass-through: the handlers delegate id resolution to resolveTaskId (like the sibling task tools); the
// mock returns the input verbatim so the call-order assertions below stay valid for any id shape.
vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => input),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

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

  it('renders the low-confidence (non-cede) suffix', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'low' } }));
    expect(md).toContain('**Recommend (low confidence — see below):** Option A');
  });

  it('renders the high-confidence suffix (B-445)', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'high' } }));
    expect(md).toContain('**Recommend (high confidence):** Option A');
  });

  it('renders the moderate-confidence suffix (B-445)', () => {
    const md = renderBrief(baseDoc({ recommend: { text: 'Option A', confidence: 'medium' } }));
    expect(md).toContain('**Recommend (moderate confidence):** Option A');
  });

  it('renders the alternatives and context sections', () => {
    const md = renderBrief(baseDoc({
      alternatives: [{ option: 'Top-level nav item', rejection: 'crowds the primary nav' }],
      context: ['B-187 shipped list-action icons'],
    }));
    expect(md).toContain('**Alternatives:**');
    expect(md).toContain('- Top-level nav item — crowds the primary nav');
    expect(md).toContain('**Context:**');
    expect(md).toContain('- B-187 shipped list-action icons');
  });

  it('renders a custom tail line in place of the default', () => {
    const md = renderBrief(baseDoc({ tail: 'Reply with your pick.' }));
    expect(md).toContain('> Reply with your pick.');
    expect(md).not.toContain('Type `accept`');
  });

  it('drops derived-constraint items from the rendered "You need to" list', () => {
    const md = renderBrief(baseDoc({ items: [decision(), { kind: 'derived-constraint', text: 'Confidentiality rule is already fixed' }] }));
    expect(md).toContain('- [ ] Pick sidebar placement');
    expect(md).not.toContain('Confidentiality rule is already fixed');
  });

  it('appends the depth-pointer footer when a decision_ref is supplied (B-674)', () => {
    const md = renderBrief(baseDoc(), { type: 'specification', id: 'abc' });
    expect(md).toContain('fuller depth lives in the linked decision entry');
  });

  it('omits the depth-pointer footer when no decision_ref is supplied (B-674)', () => {
    const md = renderBrief(baseDoc());
    expect(md).not.toContain('fuller depth lives in the linked decision entry');
  });
});

describe('lintBrief', () => {
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));
  const filler = (n: number) => [Array.from({ length: n }, (_, i) => `w${i}`).join(' ')];

  it('passes a well-formed decision brief', () => {
    const r = lint(baseDoc({ recommend: { text: 'Sub-section under project views.', confidence: 'high' } }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
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
    const r = lint(baseDoc({ why: filler(700) })); // 1 item -> tier budget 675; ~730 rendered words
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget/i);
  });

  it('scales the budget by structure (B-467): a length that warns for a minimal brief is tolerated by a larger one', () => {
    const small = lint(baseDoc({ why: filler(700) })); // 1 item -> budget 675; ~730 rendered words

    expect(small.warnings.join(' ')).toMatch(/soft budget/i);

    const large = lint(baseDoc({
      items: [decision(), decision(), decision(), decision()], // 4 units -> budget 600 + 75*4 = 900
      why: filler(700),
    }));
    expect(large.warnings.join(' ')).not.toMatch(/soft budget/i);
    expect(large.ok).toBe(true);
  });

  it('counts alternatives toward the tier budget (B-467)', () => {
    const r = lint(baseDoc({
      alternatives: [
        { option: 'A', rejection: 'x' }, { option: 'B', rejection: 'y' }, { option: 'C', rejection: 'z' },
      ], // 1 item + 3 alternatives = 4 units -> budget 900
      why: filler(400),
    }));
    expect(r.warnings.join(' ')).not.toMatch(/soft budget/i);
    expect(r.ok).toBe(true);
  });

  it('caps the tier budget and still warns past the cap (B-467)', () => {
    const items = Array.from({ length: 11 }, () => decision()); // 11 units -> 600 + 75*11 = 1425 -> capped 1400
    const r = lint(baseDoc({ items, why: filler(1500) }));      // ~1660 rendered words > 1400
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/soft budget 1400/);
  });

  it('warns (does not fail) when a recommendation has no confidence level (B-445)', () => {
    const r = lint(baseDoc()); // baseDoc recommend has no confidence level
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/no confidence level/i);
  });

  it('does not nag when an explicit confidence level is set (B-445)', () => {
    const r = lint(baseDoc({ recommend: { text: 'x', confidence: 'medium' } }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });

  it('does not nag for a confidence level on a ceded values-call (B-445)', () => {
    const r = lint(baseDoc({ recommend: { text: 'x', cede: true } }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });

  it('does not nag for a confidence level on a research-first brief with no recommend (B-445)', () => {
    const r = lint(baseDoc({ recommend: undefined, load_bearing_gap: true, research: ['Q?'], items: [decision({ deferred: true })] }));
    expect(r.warnings.join(' ')).not.toMatch(/no confidence level/i);
  });
});

// ——— B-660 legibility nudges: warn-only, calibrated two-sided ———
describe('lintBrief legibility nudges (B-660)', () => {
  // Confidence set so the only warnings in play are the nudges under test.
  const quiet = (over: Partial<BriefDoc> = {}): BriefDoc =>
    baseDoc({ recommend: { text: 'Adopt.', confidence: 'high' }, ...over });
  const lint = (doc: BriefDoc) => lintBrief(doc, renderBrief(doc));
  const NUDGE_A = /one idea per sentence/i;
  const NUDGE_B = /unstack these/i;

  const longSentence =
    Array.from({ length: SENTENCE_WORD_LIMIT + 5 }, (_, i) => `word${i}`).join(' ') + '.';

  it(`Nudge A fires on a sentence over ${SENTENCE_WORD_LIMIT} words — and never flips ok`, () => {
    const r = lint(quiet({ why: [longSentence] }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_A);
  });

  it('Nudge A is silent on short-sentence prose', () => {
    const r = lint(quiet({ why: ['Short sentences read fast. Each carries one idea. That is the contract.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A is silent when the long word-run sits inside an inline code span', () => {
    const r = lint(quiet({ why: ['`' + longSentence + '` explains it.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A is silent when the long word-run sits inside a fenced code block', () => {
    const r = lint(quiet({ why: ['```\n' + longSentence + '\n```'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge A treats rendered checkbox items as template chrome (structured fields, not prose)', () => {
    const itemText = Array.from({ length: SENTENCE_WORD_LIMIT + 5 }, (_, i) => `w${i}`).join(' ');
    const r = lint(quiet({ items: [decision({ text: itemText })] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_A);
  });

  it('Nudge B fires on a nested parenthetical (an aside inside an aside) — and never flips ok', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path (consume-on-pickup)) covers it.'] }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  it('Nudge B fires on immediately-adjacent parenthetical pairs', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path) (consume-on-pickup) covers it.'] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  it('Nudge B is SILENT on two separate parentheticals in one sentence — never a per-sentence count', () => {
    const r = lint(quiet({ why: ['The guard (the reconciliation path) covers it for now (until the redesign).'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
  });

  it('Nudge B is silent on code spans containing parens — a tool call is not a parenthetical', () => {
    const r = lint(quiet({ why: ['Call `manage_subtasks(task_id)` then `get_task(id)` to confirm the split.'] }));
    expect(r.warnings.join(' ')).not.toMatch(NUDGE_B);
  });

  // ——— Two-sided calibration (B-660) ———
  // SYNTHETIC POSITIVE reconstructed from B-550's documented failure signature — stacked
  // parentheticals (asides inside asides), five-clause 50+ word sentences, inline substrate
  // jargon. The ORIGINAL illegible brief is unrecoverable: compose_brief iterates the active
  // brief in place, so the rejected text survives in no activity event and no doc. Both
  // nudges must fire on this reconstruction.
  const B550_SYNTHETIC_POSITIVE = `## DECIDE: Adopt the gate-ui conductor split for B-550?

**Recommend (high confidence):** Adopt the reconciliation-guard sub-track split (the B-482 guard (the consume-on-auto-pickup path) already half-covers it), which lands the elicitation-claim coupling on the brief row, keeps the underwriting ids on the prune path, folds the pending_resolution consume into the iterate re-compose, threads the awaiting_human_ref through the P3 substrate's partial unique index, and defers the reshape surface to the web repo because the poll-loop arm (the B-500 auto-watch (armed at hard floors)) serializes the sub-tracks anyway.

**Why:**
- The P3 substrate already carries the partial unique index (scoped to the active row (status alone is not enough)) so the coupling rides the existing slot.

**You need to:**
- [ ] Adopt the split — *recommend: adopt*

> Type \`accept\`, \`edit\`, \`iterate <feedback>\`, or \`defer\`.`;

  it('trips BOTH nudges on the synthetic B-550 positive (reconstruction — original unrecoverable)', () => {
    const r = lintBrief(quiet(), B550_SYNTHETIC_POSITIVE);
    expect(r.ok).toBe(true); // warn-only even on the worst offender
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(NUDGE_A);
    expect(r.warnings.join(' ')).toMatch(NUDGE_B);
  });

  // BRIEF-5 from the B-660 calibration corpus — a REAL plan brief authored under the contract
  // (the shortest of the five clean negatives; all five measured silent at calibration). A
  // representative real brief must produce zero warnings of any kind.
  const CORPUS_BRIEF_5_PLAN = `## DECIDE: Approve B-660's execution plan?

**Recommend (high confidence):** Proceed. One plugin PR in a worktree created inside plugin/: recover the B-550 illegible-brief anchor, author brief-authoring.md, wire the eight skill pointers, add the two nudges to lintBrief with the compose_brief description backstop, write the nudge tests plus the pointer contract test, re-tune the budget from measurement, then full suite, typecheck, verify:dist, and a version bump to 0.14.52.

**Why:**
- Executes the two Accepted design decisions (d97ac598 product, 30bb02d1 technical) with no open choices left.
- Base verified: lintBrief, the eight compose sites, and the AC mechanics were all read in current code this session; no DB objects are touched, so there is no CREATE OR REPLACE to rebase.

**Context:**
- Build order: (1) worktree inside plugin/ — never the workspace root; (2) recover the B-550 positive anchor from activity events or the session record, else reconstruct and say so in the test; (3) brief-authoring.md; (4) the eight §-pointers; (5) compose_brief description essence + pointer; (6) the two nudges in lintBrief, code spans and URLs stripped first; (7) tests — nudges two-sided (fire on the anchor, silent on this run's briefs, never flip ok) + the compose-site pointer contract test; (8) budget re-tune from measured briefs + draft the 9599c855 dated-banner amendment, applied with the release and surfaced on its brief; (9) npm run typecheck, full npm test, npm run verify:dist, bump plugin.json to 0.14.52; (10) commit, push, PR — then stop at the release hard floor.
- Plan is the lead-by-system gate under the contract this ticket encodes: this brief is deliberately terse, and the disciplines it attests to are enforced in the build steps, not in prose the human must audit.

**You need to:**
- [ ] Execute the ten-step single-PR plan above in a plugin/ worktree — *recommend: Proceed — accept advances to Planned and the build starts*

> Type \`accept\`, \`edit\`, \`iterate <feedback>\`, or \`defer\`.`;

  it('passes a real corpus brief (BRIEF-5, the plan brief) with zero warnings', () => {
    const r = lintBrief(quiet(), CORPUS_BRIEF_5_PLAN);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
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
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'is', 'not', 'order', 'limit']) chain[m] = vi.fn(() => chain);
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
      { data: { workflow_state: 'Proposed' } },
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

  it('NULLS pending_resolution on the iterate re-compose — consumes the browser reshape (B-485 marker-clear)', async () => {
    // The in-place iterate IS the consume moment: re-composing must clear any browser-submitted reshape so
    // it is not re-consumed on the next poll. responses: [active found] -> [update row] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: { ...briefRow, iteration: 2 } }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    // the brief update (not the trailing tasks flag) carries pending_resolution: null
    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ pending_resolution: null }));
  });

  it('NULLS pending_resolution on a first compose too (insert path)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_resolution: null }));
  });

  it('degrades gracefully if pending_resolution column is absent (older DB) — retries the write without it', async () => {
    // The first iterate update 400s because the column is missing; compose retries without pending_resolution.
    // responses: [active found] -> [update errors: column absent] -> [retry update succeeds] -> [task update]
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: null, error: { message: 'column briefs.pending_resolution does not exist' } },
      { data: { ...briefRow, iteration: 2 } },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect((result.brief as any).iteration).toBe(2);
    // the retry dropped pending_resolution from the payload
    expect(client.update).toHaveBeenLastCalledWith(expect.not.objectContaining({ pending_resolution: null }));
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

  // B-466: a literal pending_activity:null must be accepted and treated as "field omitted".
  it('advertises pending_activity as nullable so a literal null is a valid input (B-466 — the defect site)', () => {
    // The defect: the advertised JSON Schema typed pending_activity as 'string', so the MCP client/harness
    // rejected a literal null before the (already null-safe) handler ran. The contract must permit null.
    const t = (composeBriefTool.inputSchema.properties as any).pending_activity.type;
    expect(t).toEqual(['string', 'null']);
  });

  it('treats pending_activity:null identically to omitting it — writes null, skips the transition guard (B-466 parity)', async () => {
    // Parity regression-lock: the handler is already null-safe (if(pending_activity) guard + ?? null), so a
    // literal null must behave exactly like an omitted field — accept advances no state. Insert path only:
    // [no active brief] -> [insert row] -> [task update]; the transition guard (workflow_transitions) must
    // NOT be queried.
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: null as any,
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625: a literal-STRING "null" is the string-serialized form of JSON null — it must be normalized to
  // omitted (parity with B-466's null≡omitted), not fed to the transition guard (where 'null' has no row).
  it('treats the literal string "null" as omitted — writes null, skips the transition guard (B-625)', async () => {
    // Insert path only: [no active brief] -> [insert row] -> [task update]; workflow_transitions must NOT be queried.
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'null',
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625: the normalization is case-insensitive and whitespace-trimmed — these variants must behave identically.
  it.each(['NULL', 'Null', ' null '])('normalizes the case/whitespace variant %j to omitted (B-625)', async (variant) => {
    const client = makeClient([{ data: null }, { data: briefRow }, { data: null }]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: variant,
    });
    expect(result.lint.ok).toBe(true);
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: null }));
    expect(client.from).not.toHaveBeenCalledWith('workflow_transitions');
  });

  // B-625 over-reach guard: a REAL activity must still validate against workflow_transitions and write through.
  it('still validates a real pending_activity — the "null" normalization does not over-reach (B-625)', async () => {
    // responses: [task state] -> [transition exists] -> [no active brief] -> [insert row] -> [task update]
    const client = makeClient([
      { data: { workflow_state: 'Proposed' } },
      { data: { to_state: 'Clarified' } },
      { data: null },
      { data: briefRow },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'clarifying',
    });
    expect(result.lint.ok).toBe(true);
    expect(client.from).toHaveBeenCalledWith('workflow_transitions');
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({ pending_activity: 'clarifying' }));
  });

  // B-625 over-reach guard: a genuine typo is NOT "null" — it must still hit the guard and throw.
  it('still throws on a typo\'d unknown activity — only the exact "null" token is normalized (B-625)', async () => {
    // responses: [task state] -> [transition lookup returns null]
    const client = makeClient([{ data: { workflow_state: 'Built' } }, { data: null }]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any, pending_activity: 'buildng',
      }),
    ).rejects.toThrow(/no valid transition/i);
    expect(client.insert).not.toHaveBeenCalled();
  });
});

// B-645 iterate-prune: the in-place iterate is the elicitation-claim disposal moment. When
// `underwriting_claim_ids` (the KEPT set) is passed, coupled dangling claims — Asserted rows whose
// underwriting_brief_id is the active brief — are archived unless kept. The mock can't filter rows,
// so "archives drop1 but not keep1 and not uncoupled/foreign rows" is expressed as the exact filter
// chain: eq(underwriting_brief_id, <active brief>) + eq(status,'Asserted') scopes OUT rows coupled to
// other briefs (e.g. a force-quit claim underwriting a different brief) and non-Asserted rows, and
// not(id, in, (keep…)) spares the kept set.
describe('composeBrief — B-645 elicitation-claim iterate-prune', () => {
  const briefRow = { id: 'brief-1', task_id: 'task-1', reason: 'clarification-draft', content: 'rendered', status: 'active', iteration: 2 };

  it('on iterate with underwriting_claim_ids=[keep1]: archives coupled Asserted claims NOT kept', async () => {
    // responses: [active found] -> [brief update] -> [prune await] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(client.from).toHaveBeenCalledWith('knowledge_decisions');
    expect(client.update).toHaveBeenCalledWith({ status: 'Archived' });
    // Scoped to THIS brief's coupled Asserted claims (drop1 matches; keep1 is spared by the not-in;
    // an uncoupled or other-brief force-quit claim never matches the underwriting_brief_id filter).
    expect(client.eq).toHaveBeenCalledWith('underwriting_brief_id', 'brief-1');
    expect(client.eq).toHaveBeenCalledWith('status', 'Asserted');
    expect(client.not).toHaveBeenCalledWith('id', 'in', '(keep1)');
  });

  it('empty array = archive ALL coupled Asserted claims (no not-in filter)', async () => {
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: [],
    });
    expect(client.update).toHaveBeenCalledWith({ status: 'Archived' });
    expect(client.eq).toHaveBeenCalledWith('underwriting_brief_id', 'brief-1');
    expect(client.not).not.toHaveBeenCalled();
  });

  it('omitted param = NO prune call (back-compat)', async () => {
    // responses: [active found] -> [brief update] -> [task update]
    const client = makeClient([{ data: { id: 'brief-1', iteration: 1 } }, { data: briefRow }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
    });
    expect(client.from).not.toHaveBeenCalledWith('knowledge_decisions');
    expect(client.update).not.toHaveBeenCalledWith({ status: 'Archived' });
  });

  it('no prune on a FIRST compose even when the param is passed (nothing is coupled yet)', async () => {
    // responses: [no active brief] -> [insert row] -> [task update]
    const client = makeClient([{ data: null }, { data: { ...briefRow, iteration: 1 } }, { data: null }]);
    await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(client.from).not.toHaveBeenCalledWith('knowledge_decisions');
  });

  it('tolerates a missing claim column on an older DB (guarded — compose still succeeds)', async () => {
    // responses: [active found] -> [brief update] -> [prune errors: column absent] -> [task update]
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: briefRow },
      { data: null, error: { message: 'column knowledge_decisions.underwriting_brief_id does not exist' } },
      { data: null },
    ]);
    const result = await composeBrief(client, PROJECT_ID, USER_ID, {
      task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
      underwriting_claim_ids: ['keep1'],
    });
    expect(result.brief).toEqual(briefRow);
  });

  it('rethrows a REAL prune failure (only the missing-column error is tolerated)', async () => {
    const client = makeClient([
      { data: { id: 'brief-1', iteration: 1 } },
      { data: briefRow },
      { data: null, error: { message: 'permission denied for table knowledge_decisions' } },
    ]);
    await expect(
      composeBrief(client, PROJECT_ID, USER_ID, {
        task_id: 'task-1', reason: 'clarification-draft', doc: okDoc as any,
        underwriting_claim_ids: ['keep1'],
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('getBrief', () => {
  it('returns the active brief for a task, with pending_resolution surfaced (B-485)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    // responses: [brief row] -> [pending_resolution read: none]
    const client = makeClient([{ data: row }, { data: { pending_resolution: null } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(client.from).toHaveBeenCalledWith('briefs');
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
    expect(result).toEqual({ ...row, pending_resolution: null });
  });

  it('surfaces a browser-submitted reshape marker on pending_resolution (B-485 / AC3)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    const pending = { command: 'iterate', detail: 'narrow the scope' };
    // responses: [brief row] -> [pending_resolution read: the reshape marker]
    const client = makeClient([{ data: row }, { data: { pending_resolution: pending } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toEqual({ ...row, pending_resolution: pending });
  });

  it('returns null (not an enriched object) when there is no active brief', async () => {
    const client = makeClient([{ data: null }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toBeNull();
  });

  it('degrades pending_resolution to null when the column read errors (older DB, no 400 on the core read)', async () => {
    const row = { id: 'brief-1', task_id: 'task-1', status: 'active' };
    // responses: [brief row] -> [pending_resolution read errors: column absent]
    const client = makeClient([{ data: row }, { data: null, error: { message: 'column briefs.pending_resolution does not exist' } }]);
    const result = await getBrief(client, PROJECT_ID, { task_id: 'task-1' });
    expect(result).toEqual({ ...row, pending_resolution: null });
  });

  it('resolves a visual ID via resolveTaskId before looking up the brief', async () => {
    const client = makeClient([{ data: { id: 'brief-1', task_id: 'uuid-x', status: 'active' } }, { data: { pending_resolution: null } }]);
    await getBrief(client, PROJECT_ID, { task_id: 'B-42' });
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-42');
  });
});

describe('fetchPendingResolution (B-485 — the conductor auto-pickup detector)', () => {
  it('returns the reshape marker when the active brief has one', async () => {
    const pending = { command: 'iterate', detail: 'defer the migration' };
    const client = makeClient([{ data: { pending_resolution: pending } }]);
    const result = await fetchPendingResolution(client, 'task-1');
    expect(result).toEqual(pending);
    expect(client.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('returns null when there is no pending reshape', async () => {
    const client = makeClient([{ data: { pending_resolution: null } }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });

  it('returns null when there is no active brief', async () => {
    const client = makeClient([{ data: null }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });

  it('returns null (never throws) when the column is absent on an older DB', async () => {
    const client = makeClient([{ data: null, error: { message: 'column briefs.pending_resolution does not exist' } }]);
    expect(await fetchPendingResolution(client, 'task-1')).toBeNull();
  });
});

describe('fetchPendingRemark (B-503 — the accept-with-remark detector)', () => {
  it('returns { brief_id, reason, detail } for the most recent unconsumed remark', async () => {
    const client = makeClient([{ data: { id: 'brief-9', reason: 'decomposition-proposal', accept_remark: 'auto-accept decompose if no-split' } }]);
    const r = await fetchPendingRemark(client, 'task-1');
    expect(r).toEqual({ brief_id: 'brief-9', reason: 'decomposition-proposal', detail: 'auto-accept decompose if no-split' });
    // The filters that define "unconsumed": remark present AND consumed-stamp NULL.
    expect(client.not).toHaveBeenCalledWith('accept_remark', 'is', null);
    expect(client.is).toHaveBeenCalledWith('accept_remark_consumed_at', null);
  });

  it('returns null when no brief carries an unconsumed remark', async () => {
    const client = makeClient([{ data: null }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });

  it('returns null on the missing-column error (older DB) — never throws (B-383 class)', async () => {
    const client = makeClient([{ data: null, error: { message: 'column briefs.accept_remark does not exist' } }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });

  it('returns null for a blank remark (nothing to consume)', async () => {
    const client = makeClient([{ data: { id: 'brief-9', reason: 'plan-draft', accept_remark: '   ' } }]);
    expect(await fetchPendingRemark(client, 'task-1')).toBeNull();
  });
});

describe('consumeAcceptRemark (B-503)', () => {
  it('stamps accept_remark_consumed_at where currently NULL — { consumed: true }', async () => {
    const client = makeClient([{ data: { id: 'brief-9' } }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: true });
    expect(client.update).toHaveBeenCalledWith({ accept_remark_consumed_at: expect.any(String) });
    // The idempotency filter: only an un-stamped remark is stamped.
    expect(client.is).toHaveBeenCalledWith('accept_remark_consumed_at', null);
  });

  it('is idempotent: a second call matches zero rows — { consumed: false, already: true }, no error', async () => {
    const client = makeClient([{ data: null }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: false, already: true });
  });

  it('pre-migration guard: the missing-column error returns { unsupported: true } cleanly (B-383 class)', async () => {
    const client = makeClient([{ data: null, error: { message: "Could not find the 'accept_remark_consumed_at' column of 'briefs' in the schema cache" } }]);
    const r = await consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' });
    expect(r).toEqual({ brief_id: 'brief-9', consumed: false, unsupported: true });
  });

  it('rethrows any OTHER error (a real failure must be loud)', async () => {
    const client = makeClient([{ data: null, error: { message: 'permission denied for table briefs' } }]);
    await expect(consumeAcceptRemark(client, PROJECT_ID, { brief_id: 'brief-9' })).rejects.toThrow(/permission denied/);
  });

  it('requires brief_id', async () => {
    const client = makeClient([]);
    await expect(consumeAcceptRemark(client, PROJECT_ID, { brief_id: '' })).rejects.toThrow(/brief_id/);
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

  it('returns the RPC payload verbatim, including the idempotent flag', async () => {
    const client = makeRpcClient({ id: 'brief-1' }, { brief_id: 'brief-1', command: 'accept', workflow_state: 'Clarified', brief_status: 'accepted', idempotent: true });
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' });
    expect(result).toEqual({ brief_id: 'brief-1', command: 'accept', workflow_state: 'Clarified', brief_status: 'accepted', idempotent: true });
  });
});

// B-517: brief-less umbrella verify-ack. A trigger-rolled-up umbrella's verify gate has no active brief,
// so the normal path can't ack it; on `accept` of such a sentinel we advance Deployed→Verified via the
// fixed-contract ack_umbrella_verify RPC. The normal active-brief path must stay completely unchanged.
describe('resolveBrief — brief-less umbrella verify-ack (B-517)', () => {
  // Two queued maybeSingle responses in call order: [active brief lookup] -> [task-row lookup]. rpc returns
  // its own result. The rpc-name assertions confirm we called the umbrella RPC, not resolve_brief.
  function makeUmbrellaClient(briefRow: unknown, taskRow: unknown, rpcResult: unknown) {
    const responses = [{ data: briefRow, error: null }, { data: taskRow, error: null }];
    let i = 0;
    const chain: any = {};
    for (const m of ['from', 'select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => responses[i++] ?? { data: null, error: null });
    chain.rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
    return chain;
  }

  const sentinel = {
    workflow_state: 'Deployed',
    awaiting_human_reason: 'verification-ack-pending',
    awaiting_human_ref: { kind: 'umbrella-auto-verify' },
  };

  it('on accept with NO active brief, calls ack_umbrella_verify and returns its result', async () => {
    const rpcResult = { task_id: 'task-1', workflow_state: 'Verified' };
    const client = makeUmbrellaClient(null, sentinel, rpcResult);
    const result = await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' });
    expect(client.rpc).toHaveBeenCalledWith('ack_umbrella_verify', { _task_id: 'task-1' });
    // and it did NOT fall through to the resolve_brief RPC
    expect(client.rpc).not.toHaveBeenCalledWith('resolve_brief', expect.anything());
    expect(result).toEqual(rpcResult);
  });

  it('leaves the normal active-brief accept path UNCHANGED — still calls resolve_brief, never ack_umbrella_verify', async () => {
    // active brief present -> umbrella branch is never entered.
    const client = makeUmbrellaClient({ id: 'brief-1' }, sentinel, { brief_status: 'accepted' });
    await resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' });
    expect(client.rpc).toHaveBeenCalledWith('resolve_brief', { _brief_id: 'brief-1', _command: 'accept', _detail: null });
    expect(client.rpc).not.toHaveBeenCalledWith('ack_umbrella_verify', expect.anything());
  });

  it('still errors (no ack) when the brief-less task is NOT an umbrella-auto-verify sentinel', async () => {
    const notSentinel = { workflow_state: 'Built', awaiting_human_reason: null, awaiting_human_ref: null };
    const client = makeUmbrellaClient(null, notSentinel, { task_id: 'task-1' });
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'accept' }))
      .rejects.toThrow(/no active brief/i);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('does NOT ack a brief-less umbrella on defer — that stays out of scope (still errors)', async () => {
    const client = makeUmbrellaClient(null, sentinel, { task_id: 'task-1' });
    await expect(resolveBrief(client, PROJECT_ID, { task_id: 'task-1', command: 'defer', detail: 'later' }))
      .rejects.toThrow(/no active brief/i);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
