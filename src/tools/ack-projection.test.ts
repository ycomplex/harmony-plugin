// B-683: mutation-ack projection tests.
//
// Three layers:
//   1. REGRESSION PIN — enumerate every tool name from handleToolCall's dispatch switch (parsed
//      from the source) and assert each one is explicitly classified: a known read, a projection
//      entry, or an annotated pass-through. A future tool added to the dispatch without a decided
//      ack FAILS here.
//   2. Per-tool ack shape — required server-computed fields present, caller-sent body ABSENT.
//   3. handleToolCall integration — the projection is applied at the MCP boundary and the
//      serialized result is compact JSON (no newlines/pretty-print).

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { ackProjections, ACK_PASS_THROUGH, projectAck } from './ack-projection.js';
import { handleToolCall } from './index.js';

// ---------------------------------------------------------------------------
// 1. Regression pin: every dispatched tool is classified read / projection / pass-through
// ---------------------------------------------------------------------------

/** Read-only tools: results pass through unchanged BY DESIGN (no ack decision needed). A new READ
 *  tool must be added here; a new WRITE tool must get a projection or an ACK_PASS_THROUGH entry. */
const READ_TOOLS = [
  'get_project',
  'list_epics',
  'list_tasks',
  'get_task',
  'list_labels',
  'list_checklist_items',
  'query_tasks',
  'search_tasks',
  'find_related_tickets',
  'list_comments',
  'list_activity',
  'list_members',
  'query_knowledge',
  'search_ticket_intents',
  'get_knowledge_entry',
  'query_facts',
  'query_entities',
  'list_milestones',
  'list_cycles',
  'list_acceptance_criteria',
  'list_test_cases',
  'list_dependencies',
  'list_subtasks',
  'list_parent',
  'get_brief',
  'get_elicitation',
  'list_ticket_knowledge',
  'get_build_evidence_status',
  // download_attachment writes a LOCAL file but reads Harmony state — no record echo to strip.
  'download_attachment',
];

function dispatchToolNames(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'index.ts'), 'utf8');
  // Only the dispatch switch uses `case '<tool_name>':` — matches every dispatched tool.
  const names = [...source.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(50); // sanity: the parse found the dispatch
  return names;
}

describe('ack projection pin (B-683)', () => {
  it('classifies EVERY dispatched tool: read, projection, or annotated pass-through', () => {
    const unclassified = dispatchToolNames().filter(
      (name) =>
        !READ_TOOLS.includes(name) &&
        !(name in ackProjections) &&
        !(name in ACK_PASS_THROUGH),
    );
    // A future write tool without a decided ack lands here and fails the suite.
    expect(unclassified).toEqual([]);
  });

  it('no tool is both projected and pass-through (exactly one decision each)', () => {
    const both = Object.keys(ackProjections).filter((name) => name in ACK_PASS_THROUGH);
    expect(both).toEqual([]);
  });

  it('no read tool carries a projection or pass-through annotation', () => {
    const misfiled = READ_TOOLS.filter(
      (name) => name in ackProjections || name in ACK_PASS_THROUGH,
    );
    expect(misfiled).toEqual([]);
  });

  it('every projection / pass-through entry corresponds to a dispatched tool', () => {
    const dispatched = dispatchToolNames();
    const stale = [...Object.keys(ackProjections), ...Object.keys(ACK_PASS_THROUGH)].filter(
      (name) => !dispatched.includes(name),
    );
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-tool ack shapes: required fields present, caller-sent body ABSENT
// ---------------------------------------------------------------------------

const LONG_BODY = 'A long caller-sent body that must never be echoed back. '.repeat(20);

describe('projectAck — reads pass through', () => {
  it('returns the identical result object for a tool without a projection', () => {
    const big = { id: 't1', description: LONG_BODY, acceptance_criteria: [{ id: 'ac1' }] };
    expect(projectAck('get_task', big, { task_id: 'B-1' })).toBe(big);
  });

  it('returns the identical result for annotated pass-through write tools', () => {
    const resolveResult = {
      task_id: 't1',
      brief_id: 'b1',
      workflow_state: 'Clarified',
      brief_status: 'resolved',
      command: 'accept',
      idempotent: false,
    };
    expect(projectAck('resolve_brief', resolveResult, { task_id: 'B-1', command: 'accept' })).toBe(
      resolveResult,
    );
    const advanceResult = {
      task_id: 't1',
      from_state: 'Planned',
      to_state: 'Built',
      activity: 'building',
      task: { id: 't1', workflow_state: 'Built', workflow_activity: 'building' },
    };
    expect(
      projectAck('advance_workflow', advanceResult, { task_id: 'B-1', activity: 'building' }),
    ).toBe(advanceResult);
    const refResult = { task_id: 't1', decision_id: 'd1', linked: true };
    expect(
      projectAck('reference_knowledge', refResult, { task_id: 'B-1', decision_id: 'd1' }),
    ).toBe(refResult);
    const labelsResult = { added: ['l1'], removed: ['l2'] };
    expect(projectAck('manage_labels', labelsResult, { task_id: 'B-1', add: ['l1'] })).toBe(
      labelsResult,
    );
  });
});

describe('projectAck — task tools', () => {
  const fullTaskRow = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    task_number: 683,
    title: 'Some caller-sent title',
    description: LONG_BODY,
    status: 'Backlog',
    workflow_state: 'Captured',
    project_id: 'proj-1',
    created_by: 'user-1',
    field_values: {},
    updated_at: '2026-07-08T10:00:00Z',
    created_at: '2026-07-08T10:00:00Z',
  };

  it('create_task keeps id/task_number/workflow_state, drops title+description', () => {
    const ack = projectAck('create_task', fullTaskRow, {
      title: 'Some caller-sent title',
      description: LONG_BODY,
    }) as Record<string, unknown>;
    expect(ack).toEqual({
      id: fullTaskRow.id,
      task_number: 683,
      workflow_state: 'Captured',
    });
    expect(JSON.stringify(ack)).not.toContain('caller-sent');
  });

  it('bulk_create_tasks maps created rows to compact identities with a count', () => {
    const ack = projectAck('bulk_create_tasks', [fullTaskRow, { ...fullTaskRow, id: 'x2', task_number: 684 }], {
      tasks: [{ title: 't1', description: LONG_BODY }],
    }) as { created: unknown[]; count: number };
    expect(ack.count).toBe(2);
    expect(ack.created[0]).toEqual({ id: fullTaskRow.id, task_number: 683, workflow_state: 'Captured' });
    expect(JSON.stringify(ack)).not.toContain(LONG_BODY.slice(0, 20));
  });

  it('update_task keeps state fields + changed_fields, and MUST NOT echo the description', () => {
    const args = { task_id: 'B-683', description: LONG_BODY, priority: 'high' };
    const ack = projectAck('update_task', { ...fullTaskRow, priority: 'high' }, args) as Record<
      string,
      unknown
    >;
    expect(ack).toEqual({
      id: fullTaskRow.id,
      task_number: 683,
      status: 'Backlog',
      workflow_state: 'Captured',
      updated_at: '2026-07-08T10:00:00Z',
      changed_fields: ['description', 'priority'],
    });
    expect(JSON.stringify(ack)).not.toContain('never be echoed');
  });

  it('bulk_update_tasks returns matched ids + changed_fields, not rows', () => {
    const rows = [
      { ...fullTaskRow, id: 'u1' },
      { ...fullTaskRow, id: 'u2' },
    ];
    const ack = projectAck('bulk_update_tasks', rows, {
      task_ids: ['u1', 'u2', 'u3-missing'],
      status: 'Done',
    });
    expect(ack).toEqual({ updated: ['u1', 'u2'], count: 2, changed_fields: ['status'] });
  });

  it('subsume_task drops the caller-echoed reason', () => {
    const ack = projectAck(
      'subsume_task',
      {
        task_id: 't1',
        subsumed_by_task_id: 't2',
        archived: true,
        already_subsumed: false,
        reason: LONG_BODY,
      },
      { task_id: 'B-1', subsumed_by_task_id: 'B-2', reason: LONG_BODY },
    );
    expect(ack).toEqual({
      task_id: 't1',
      subsumed_by_task_id: 't2',
      archived: true,
      already_subsumed: false,
    });
  });

  it('manage_subtasks keeps attached/detached ids and compact created identities', () => {
    const result = {
      attached: ['c1'],
      created: [
        { id: 'n1', task_number: 700, title: 'new child', status: 'Backlog', project_id: 'p', parent_task_id: 't1' },
      ],
      detached: ['c2'],
    };
    const ack = projectAck('manage_subtasks', result, {
      task_id: 'B-1',
      add_new: [{ title: 'new child', description: LONG_BODY }],
    });
    expect(ack).toEqual({
      attached: ['c1'],
      created: [{ id: 'n1', task_number: 700 }],
      detached: ['c2'],
    });
  });
});

describe('projectAck — batch child-record managers', () => {
  const batchResult = {
    added: [
      { id: 'a1', content: LONG_BODY, checked: false, position: 0, created_by: 'u' },
      { id: 'a2', content: LONG_BODY, checked: false, position: 1, created_by: 'u' },
    ],
    updated: [{ id: 'u1', content: LONG_BODY, checked: true }],
    deleted: ['d1'],
  };

  for (const tool of ['manage_acceptance_criteria', 'manage_test_cases', 'manage_checklist_items']) {
    it(`${tool} returns id lists + counts, never the content`, () => {
      const ack = projectAck(tool, batchResult, {
        task_id: 'B-1',
        add: [{ content: LONG_BODY }],
      });
      expect(ack).toEqual({
        added: ['a1', 'a2'],
        updated: ['u1'],
        deleted: ['d1'],
        counts: { added: 2, updated: 1, deleted: 1 },
      });
    });
  }

  it('manage_dependencies keeps dependency-row ids (needed for later remove)', () => {
    const ack = projectAck(
      'manage_dependencies',
      {
        added: [{ id: 'dep-row-1', task_id: 't1', blocked_by_task_id: 't2', created_by: 'u' }],
        removed: ['dep-row-0'],
      },
      { task_id: 'B-1', add: ['B-2'] },
    );
    expect(ack).toEqual({ added: ['dep-row-1'], removed: ['dep-row-0'] });
  });
});

describe('projectAck — knowledge tools', () => {
  const decisionRow = {
    id: 'dec-1',
    workspace_id: 'w',
    project_id: 'p',
    title: 'caller title',
    content: LONG_BODY,
    type: 'technical-design',
    status: 'Asserted',
    domain: ['engineering'],
    madr: { context: LONG_BODY },
    created_by: 'u',
    created_at: '2026-07-08T10:00:00Z',
    updated_at: '2026-07-08T10:00:00Z',
  };

  it('record_decision keeps { id, status, created_at } — id feeds decision_ref', () => {
    const ack = projectAck('record_decision', decisionRow, {
      type: 'technical-design',
      title: 'caller title',
      content: LONG_BODY,
    });
    expect(ack).toEqual({ id: 'dec-1', status: 'Asserted', created_at: '2026-07-08T10:00:00Z' });
  });

  it('create_knowledge_entry keeps { id, status, created_at }', () => {
    const ack = projectAck('create_knowledge_entry', decisionRow, {
      title: 'caller title',
      content: LONG_BODY,
      type: 'specification',
    });
    expect(ack).toEqual({ id: 'dec-1', status: 'Asserted', created_at: '2026-07-08T10:00:00Z' });
  });

  it('update_knowledge_entry never echoes content/madr; reports changed_fields', () => {
    const ack = projectAck('update_knowledge_entry', decisionRow, {
      entry_id: 'dec-1',
      content: LONG_BODY,
      madr: { context: LONG_BODY },
    });
    expect(ack).toEqual({
      id: 'dec-1',
      status: 'Asserted',
      updated_at: '2026-07-08T10:00:00Z',
      changed_fields: ['content', 'madr'],
    });
  });

  it('supersede_knowledge_entry compacts both halves, keeping the linkage', () => {
    const ack = projectAck(
      'supersede_knowledge_entry',
      {
        superseded: { ...decisionRow, status: 'Superseded', superseded_by: 'dec-2' },
        replacement: { ...decisionRow, id: 'dec-2', status: 'accepted' },
      },
      { entry_id: 'dec-1', new_title: 'x', new_content: LONG_BODY },
    );
    expect(ack).toEqual({
      superseded: { id: 'dec-1', status: 'Superseded', superseded_by: 'dec-2' },
      replacement: { id: 'dec-2', status: 'accepted', created_at: '2026-07-08T10:00:00Z' },
    });
  });

  it('supersede_decision preserves the retire-mode null replacement', () => {
    const ack = projectAck(
      'supersede_decision',
      { superseded: { ...decisionRow, status: 'Superseded', superseded_by: null }, replacement: null },
      { old_decision_id: 'dec-1' },
    );
    expect(ack).toEqual({
      superseded: { id: 'dec-1', status: 'Superseded', superseded_by: null },
      replacement: null,
    });
  });

  it('assert_fact keeps the server-resolved subject_entity_id, drops the object payload', () => {
    const ack = projectAck(
      'assert_fact',
      {
        id: 'f1',
        workspace_id: 'w',
        subject_entity_id: 'e1',
        predicate: 'uses',
        object: { big: LONG_BODY },
        status: 'Asserted',
        valid_from: '2026-07-08T10:00:00Z',
        recorded_at: '2026-07-08T10:00:00Z',
      },
      { subject_entity: 'thing', predicate: 'uses', object: { big: LONG_BODY }, source_type: 'manual' },
    );
    expect(ack).toEqual({
      id: 'f1',
      subject_entity_id: 'e1',
      status: 'Asserted',
      valid_from: '2026-07-08T10:00:00Z',
    });
  });

  it('invalidate_fact keeps { id, status, valid_to }', () => {
    const ack = projectAck(
      'invalidate_fact',
      { id: 'f1', status: 'Superseded', valid_to: '2026-07-08T11:00:00Z', object: LONG_BODY },
      { fact_id: 'f1' },
    );
    expect(ack).toEqual({ id: 'f1', status: 'Superseded', valid_to: '2026-07-08T11:00:00Z' });
  });

  it('create_entity drops the caller-sent kind/name/description', () => {
    const ack = projectAck(
      'create_entity',
      { id: 'e1', kind: 'persona', name: 'Founder', description: LONG_BODY, metadata: {}, created_at: 'ts' },
      { kind: 'persona', name: 'Founder', description: LONG_BODY },
    );
    expect(ack).toEqual({ id: 'e1', created_at: 'ts' });
  });

  it('update_entity reports changed_fields without echoing them', () => {
    const ack = projectAck(
      'update_entity',
      { id: 'e1', kind: 'persona', name: 'Founder', description: LONG_BODY },
      { kind: 'persona', name: 'Founder', description: LONG_BODY },
    );
    expect(ack).toEqual({ id: 'e1', changed_fields: ['description'] });
  });

  it('reconcile_entity keeps mode + merge accounting, shrinks the entity to its id', () => {
    const ack = projectAck(
      'reconcile_entity',
      {
        mode: 'merge',
        entity: { id: 'typed-1', kind: 'feature', name: 'Search', description: LONG_BODY },
        merged_stub_id: 'stub-1',
        repointed: { facts: 3, decisions: 2, events: 0 },
      },
      { name: 'Search', to_kind: 'feature' },
    );
    expect(ack).toEqual({
      mode: 'merge',
      entity: { id: 'typed-1' },
      merged_stub_id: 'stub-1',
      repointed: { facts: 3, decisions: 2, events: 0 },
    });
  });

  it('reconcile_entity upgrade-in-place omits absent merge fields', () => {
    const ack = projectAck(
      'reconcile_entity',
      { mode: 'upgrade-in-place', entity: { id: 'e1', kind: 'feature', name: 'Search' } },
      { name: 'Search', to_kind: 'feature' },
    );
    expect(ack).toEqual({ mode: 'upgrade-in-place', entity: { id: 'e1' } });
  });
});

describe('projectAck — milestones / cycles / epics / labels / comments', () => {
  it('create_epic keeps server-computed position, drops name/color', () => {
    const ack = projectAck(
      'create_epic',
      { id: 'ep1', project_id: 'p', name: 'Tech Debt', color: '#6366f1', position: 4, created_by: 'u', created_at: 'ts' },
      { name: 'Tech Debt' },
    );
    expect(ack).toEqual({ id: 'ep1', position: 4, created_at: 'ts' });
  });

  it('update_epic reports changed_fields', () => {
    const ack = projectAck(
      'update_epic',
      { id: 'ep1', name: 'Renamed', color: '#000000' },
      { epic_id: 'ep1', name: 'Renamed' },
    );
    expect(ack).toEqual({ id: 'ep1', changed_fields: ['name'] });
  });

  it('create_label keeps only the id', () => {
    const ack = projectAck('create_label', { id: 'l1', name: 'bug', color: 'red' }, { name: 'bug', color: 'red' });
    expect(ack).toEqual({ id: 'l1' });
  });

  it('add_comment never echoes the content', () => {
    const ack = projectAck(
      'add_comment',
      { id: 'c1', task_id: 't1', user_id: 'u1', content: LONG_BODY, created_at: 'ts', updated_at: 'ts' },
      { task_id: 'B-1', content: LONG_BODY },
    );
    expect(ack).toEqual({ id: 'c1', created_at: 'ts' });
  });

  it('create_milestone / update_milestone compact to identity + change record', () => {
    expect(
      projectAck(
        'create_milestone',
        { id: 'm1', project_id: 'p', name: 'v1', description: LONG_BODY, status: 'planning', created_at: 'ts' },
        { name: 'v1', description: LONG_BODY },
      ),
    ).toEqual({ id: 'm1', status: 'planning', created_at: 'ts' });
    expect(
      projectAck(
        'update_milestone',
        { id: 'm1', name: 'v1.1', description: LONG_BODY, updated_at: 'ts2' },
        { milestone_id: 'm1', description: LONG_BODY },
      ),
    ).toEqual({ id: 'm1', updated_at: 'ts2', changed_fields: ['description'] });
  });

  it('ship_milestone keeps its server-computed summary, trims the milestone row', () => {
    const ack = projectAck(
      'ship_milestone',
      {
        milestone: { id: 'm1', project_id: 'p', name: 'v1', description: LONG_BODY, status: 'shipped', shipped_at: 'ts', position: 2 },
        shipped_task_count: 7,
        removed_tasks: [{ id: 't9', title: 'straggler', status: 'In Progress' }],
      },
      { milestone_id: 'm1' },
    );
    expect(ack).toEqual({
      milestone: { id: 'm1', name: 'v1', status: 'shipped', shipped_at: 'ts' },
      shipped_task_count: 7,
      removed_tasks: [{ id: 't9', title: 'straggler', status: 'In Progress' }],
    });
  });

  it('create_cycle keeps server-computed sequence/end_date, drops the echoed start_date', () => {
    const ack = projectAck(
      'create_cycle',
      { id: 'cy1', project_id: 'p', name: 'Cycle 1', sequence_number: 1, start_date: '2026-07-08', end_date: '2026-07-21', created_at: 'ts' },
      { start_date: '2026-07-08' },
    );
    expect(ack).toEqual({ id: 'cy1', sequence_number: 1, end_date: '2026-07-21', created_at: 'ts' });
  });

  it('update_cycle confirms the applied window + changed_fields', () => {
    const ack = projectAck(
      'update_cycle',
      { id: 'cy1', name: 'Renamed', sequence_number: 2, start_date: '2026-07-08', end_date: '2026-07-30' },
      { cycle_id: 'cy1', end_date: '2026-07-30' },
    );
    expect(ack).toEqual({
      id: 'cy1',
      sequence_number: 2,
      start_date: '2026-07-08',
      end_date: '2026-07-30',
      changed_fields: ['end_date'],
    });
  });
});

describe('projectAck — compose_brief', () => {
  it('keeps the server-rendered content + lint, drops the doc echo and expand/related', () => {
    const doc = { decide: 'X?', items: [{ kind: 'decision', text: 'Y', recommendation: 'Z' }] };
    const result = {
      brief: {
        id: 'b1',
        task_id: 't1',
        reason: 'clarification-draft',
        doc,
        content: '## DECIDE: X?\n\n- [ ] Y — *recommend: Z*\n\n> Type `accept`…',
        expand_sections: { reasoning: LONG_BODY },
        related: [{ big: LONG_BODY }],
        pending_activity: 'clarifying',
        decision_ref: { type: 'specification', id: 'dec-1' },
        status: 'active',
        iteration: 2,
        resolved_command: null,
        resolved_detail: null,
        resolved_at: null,
        created_by: 'u',
        created_at: 'ts',
        updated_at: 'ts',
      },
      lint: { ok: true, errors: [], warnings: ['soft warning'] },
    };
    const ack = projectAck('compose_brief', result, {
      task_id: 'B-1',
      reason: 'clarification-draft',
      doc,
      expand_sections: { reasoning: LONG_BODY },
    }) as { brief: Record<string, unknown>; lint: unknown };
    expect(ack.brief).toEqual({
      id: 'b1',
      reason: 'clarification-draft',
      status: 'active',
      iteration: 2,
      pending_activity: 'clarifying',
      decision_ref: { type: 'specification', id: 'dec-1' },
      content: '## DECIDE: X?\n\n- [ ] Y — *recommend: Z*\n\n> Type `accept`…',
    });
    expect(ack.lint).toEqual({ ok: true, errors: [], warnings: ['soft warning'] });
    expect(JSON.stringify(ack)).not.toContain('never be echoed');
    expect(ack.brief).not.toHaveProperty('doc');
    expect(ack.brief).not.toHaveProperty('expand_sections');
    expect(ack.brief).not.toHaveProperty('related');
  });
});

describe('projectAck — elicitation tools', () => {
  const exchangeRow = {
    id: 'ex1',
    task_id: 't1',
    trigger: 'pre-draft-clarify',
    gate: 'clarifying',
    brief_id: null,
    status: 'active',
    rounds: [
      { n: 1, context_line: 'framing', questions: [{ id: 'q1', text: LONG_BODY, stakes: 'low', kind: 'open' }], answers: {}, filed_at: 'ts' },
      { n: 2, context_line: 'framing 2', questions: [{ id: 'q2', text: LONG_BODY, stakes: 'low', kind: 'open' }], answers: {}, filed_at: 'ts' },
    ],
    answers_submitted_at: null,
    force_quit_requested_at: null,
    created_by: 'u',
    created_at: 'ts',
    updated_at: 'ts',
  };

  it('start/file/conclude compact the exchange to identity + marker state', () => {
    for (const tool of ['start_elicitation', 'file_elicitation_round', 'conclude_elicitation']) {
      const ack = projectAck(tool, exchangeRow, { task_id: 'B-1' });
      expect(ack).toEqual({
        id: 'ex1',
        task_id: 't1',
        status: 'active',
        round: 2,
        answers_submitted_at: null,
        force_quit_requested_at: null,
      });
      expect(JSON.stringify(ack)).not.toContain('never be echoed');
    }
  });

  it('preserves the typed exchange-cancelled no-op shape (B-461 contract)', () => {
    const noop = { noop: true, cause: 'exchange-cancelled', exchange: { ...exchangeRow, status: 'abandoned' } };
    for (const tool of ['file_elicitation_round', 'conclude_elicitation']) {
      const ack = projectAck(tool, noop, { task_id: 'B-1' }) as Record<string, unknown>;
      expect(ack.noop).toBe(true);
      expect(ack.cause).toBe('exchange-cancelled');
      expect(ack.exchange).toEqual({
        id: 'ex1',
        task_id: 't1',
        status: 'abandoned',
        round: 2,
        answers_submitted_at: null,
        force_quit_requested_at: null,
      });
    }
  });

  it('an exchange with no rounds acks round 0', () => {
    const ack = projectAck('start_elicitation', { ...exchangeRow, rounds: [] }, { task_id: 'B-1' }) as Record<string, unknown>;
    expect(ack.round).toBe(0);
  });
});

describe('projectAck — attach_file', () => {
  it('keeps finalize-computed metadata, drops the caller-derived filename', () => {
    const ack = projectAck(
      'attach_file',
      { attachment_id: 'att1', task_id: 't1', filename: 'diagram.png', content_type: 'image/png', byte_size: 1234, status: 'finalized' },
      { task_id: 'B-1', file_path: '/tmp/diagram.png' },
    );
    expect(ack).toEqual({
      attachment_id: 'att1',
      task_id: 't1',
      content_type: 'image/png',
      byte_size: 1234,
      status: 'finalized',
    });
  });
});

describe('projectAck — defensive on degenerate results', () => {
  it('passes null / non-object results through unchanged', () => {
    expect(projectAck('update_task', null, { task_id: 'B-1' })).toBeNull();
    expect(projectAck('create_task', undefined, { title: 'x' })).toBeUndefined();
    expect(projectAck('bulk_update_tasks', null, { task_ids: ['a'] })).toBeNull();
    expect(projectAck('compose_brief', 'weird', { task_id: 'B-1' })).toBe('weird');
  });
});

// ---------------------------------------------------------------------------
// 3. handleToolCall integration: projection applied at the boundary + compact JSON
// ---------------------------------------------------------------------------

describe('handleToolCall boundary (B-683)', () => {
  const TASK_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

  function mockUpdateTaskClient(row: Record<string, unknown>) {
    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.select = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: row, error: null });
    return chain;
  }

  it('serializes a projected, compact ack — no pretty-print, no caller echo', async () => {
    const row = {
      id: TASK_UUID,
      task_number: 683,
      title: 't',
      description: LONG_BODY,
      status: 'Backlog',
      workflow_state: 'Captured',
      updated_at: 'ts',
    };
    const res = await handleToolCall(
      'update_task',
      { task_id: TASK_UUID, description: LONG_BODY },
      mockUpdateTaskClient(row) as any,
      'proj-1',
      'user-1',
    );
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('\n'); // Lever 2: compact JSON
    expect(text).not.toContain('never be echoed'); // Lever 1: no caller echo
    expect(JSON.parse(text)).toEqual({
      id: TASK_UUID,
      task_number: 683,
      status: 'Backlog',
      workflow_state: 'Captured',
      updated_at: 'ts',
      changed_fields: ['description'],
    });
  });

  it('serializes read results compact but otherwise unchanged', async () => {
    const epics = [{ id: 'e1', name: 'Tech Debt', color: '#6366f1', position: 0 }];
    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockResolvedValue({ data: epics, error: null });
    const res = await handleToolCall('list_epics', {}, chain as any, 'proj-1', 'user-1');
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(epics);
  });
});
