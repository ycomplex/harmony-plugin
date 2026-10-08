// B-1073 fast-track-daemon-ending round — the TS-side half of the daemon-ending contract.
//
// `skills/harmony-fasttrack/SKILL.md`'s daemon branch (Build phase, step 3) is built on ONE load-bearing
// assumption: that calling `runRecordedWalk` with `to_gate: 'build'` from a fresh `Captured`-state ticket
// lands the ticket at `Built` with clarify/decompose/design/plan/build landed and NOTHING past it — no
// release/deploy/verify gate slot, no release-shaped brief — so the daemon branch's OWN subsequent
// `compose_brief` call (the one that drafts the real `release-decision-pending` brief) is landing onto a
// clean, unclaimed row shape, never racing or duplicating a brief this walk itself already wrote.
//
// This file pins exactly that assumption at the TS layer. The skill-prose half — the actual
// `compose_brief` call in harmony-fasttrack's Build phase — is NOT independently unit-testable from here,
// same as `checkPrePrOpenEligibility`'s own documented gap (see pre-pr-open-eligibility-contract.test.ts's
// header: "has NO call site in this repository's own TypeScript today"). Prose correctness there is
// covered by harmony-fasttrack.contract.test.ts's phrase-pinning, not by a runtime test.
//
// Mocking mirrors record-walk.test.ts's own `makeClient` / module-mock discipline exactly — this is a
// second, narrower lens on the SAME `runRecordedWalk` function, not a reimplementation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  composeBrief: vi.fn(async () => ({ brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } })),
  resolveBrief: vi.fn(async () => ({ status: 'accepted' })),
  consumePendingAcceptanceEvent: vi.fn(async () => ({ status: 'none' as const })),
  writeGateSlot: vi.fn(async (_client: unknown, args: any) => ({ gate: args.gate, applied: true, keys: Object.keys(args.content) })),
  advanceWorkflow: vi.fn(async (_c: unknown, _p: string, args: any) => ({ task_id: 't', from_state: 'Planned', to_state: 'Built', activity: args.activity, task: {} })),
  addComment: vi.fn(async () => ({ id: 'comment-1' })),
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => `resolved-${input}`),
  manageAcceptanceCriteria: vi.fn(async () => ({ added: [{ id: 'ac-1' }], updated: [], deleted: [] })),
  listAcceptanceCriteria: vi.fn(async () => ([{ id: 'ac-1', content: 'the recorded AC', checked: true, position: 0, created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' }])),
  recordDecision: vi.fn(async (_c: unknown, _p: string, _u: string, args: any) => ({ id: `decision-${args.type}-${args.source_activity}`, ...args })),
  queryKnowledge: vi.fn(async () => ([] as any[])),
  referenceKnowledge: vi.fn(async () => ({ linked: true })),
}));
const {
  composeBrief, resolveBrief, consumePendingAcceptanceEvent, writeGateSlot, advanceWorkflow, addComment,
  resolveTaskId, manageAcceptanceCriteria, listAcceptanceCriteria, recordDecision, queryKnowledge, referenceKnowledge,
} = mocks;

vi.mock('./briefs.js', () => ({ composeBrief: mocks.composeBrief, resolveBrief: mocks.resolveBrief }));
vi.mock('./acceptance-events.js', () => ({ consumePendingAcceptanceEvent: mocks.consumePendingAcceptanceEvent }));
vi.mock('./gate-slots.js', () => ({ writeGateSlot: mocks.writeGateSlot }));
vi.mock('./workflow.js', () => ({ advanceWorkflow: mocks.advanceWorkflow, referenceKnowledge: mocks.referenceKnowledge }));
vi.mock('./comments.js', () => ({ addComment: mocks.addComment }));
vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));
vi.mock('./acceptance-criteria.js', () => ({
  manageAcceptanceCriteria: mocks.manageAcceptanceCriteria,
  listAcceptanceCriteria: mocks.listAcceptanceCriteria,
}));
vi.mock('./knowledge.js', () => ({ recordDecision: mocks.recordDecision, queryKnowledge: mocks.queryKnowledge }));

import { runRecordedWalk } from './record-walk.js';

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

/** Tracks the ticket's own `workflow_state` the way a real `tasks` row would — the ONE piece of
 *  "the ticket read back" this contract needs. Every `advance_workflow` call this walk makes updates
 *  it, so a post-walk `get_task`-shaped read (`currentWorkflowState()`) reflects the walk's actual
 *  effect, not a fixed fixture value. */
function makeStatefulClient(initialState: string) {
  let workflowState = initialState;
  advanceWorkflow.mockImplementation(async (_c: unknown, _p: string, args: any) => {
    const toState = args.activity === 'proposing' ? 'Proposed'
      : args.activity === 'building' ? 'Built'
      : args.activity === 'deploying' ? 'Deployed'
      : workflowState;
    const fromState = workflowState;
    workflowState = toState;
    return { task_id: 't', from_state: fromState, to_state: toState, activity: args.activity, task: {} };
  });
  const client = {
    from: vi.fn((table: string) => {
      if (table !== 'tasks') throw new Error(`unexpected table read in test client: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: { workflow_state: workflowState }, error: null }),
            }),
          }),
        }),
      };
    }),
  } as any;
  return { client, currentWorkflowState: () => workflowState };
}

const eligibleArgs = () => ({
  task_id: 'B-2000',
  summary: 'Fix the flaky retry timer in the poller.',
  evidence: [{ url: 'https://github.com/ycomplex/harmony-plugin/pull/1', repo: 'ycomplex/harmony-plugin', paths: ['src/tools/foo.ts'] }],
  attest_walk: 'walked the poller locally for 8 minutes, confirmed the retry timer no longer flakes',
});

beforeEach(() => {
  vi.clearAllMocks();
  composeBrief.mockResolvedValue({ brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } } as any);
  resolveBrief.mockResolvedValue({ status: 'accepted' } as any);
  consumePendingAcceptanceEvent.mockResolvedValue({ status: 'none' } as any);
  writeGateSlot.mockImplementation(async (_client: unknown, args: any) => ({ gate: args.gate, applied: true, keys: Object.keys(args.content) }));
  addComment.mockResolvedValue({ id: 'comment-1' } as any);
  resolveTaskId.mockImplementation(async (_c: unknown, _p: string, input: string) => `resolved-${input}`);
  manageAcceptanceCriteria.mockResolvedValue({ added: [{ id: 'ac-1' }], updated: [], deleted: [] } as any);
  listAcceptanceCriteria.mockResolvedValue([{ id: 'ac-1', content: 'the recorded AC', checked: true, position: 0, created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' }] as any);
  recordDecision.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => ({ id: `decision-${args.type}-${args.source_activity}`, ...args }));
  queryKnowledge.mockResolvedValue([] as any[]);
  referenceKnowledge.mockResolvedValue({ linked: true } as any);
});

describe('daemon-ending contract (B-1073 fast-track-daemon-ending round): to_gate: \'build\' from Captured', () => {
  it("lands the ticket at Built, walking exactly clarify/decompose/design/plan/build and nothing past it", async () => {
    const { client, currentWorkflowState } = makeStatefulClient('Captured');

    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, {
      ...eligibleArgs(),
      to_gate: 'build',
    });

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build']);
    expect(result.stopped_at_gate).toBe('build');

    // Read the ticket back (the same shape a post-walk `get_task` would surface) — workflow_state is
    // Built, the daemon branch's OWN subsequent compose_brief call is landing on a Built row.
    expect(currentWorkflowState()).toBe('Built');

    // No release/verify-shaped brief or gate slot landed by the walk itself — exactly the row shape
    // the daemon branch's own compose_brief call (the REAL release brief) is designed to land onto.
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
    ]);
    expect(composeBrief.mock.calls.every((c: any) => c[3].reason !== 'release-decision-pending')).toBe(true);
    expect(composeBrief.mock.calls.every((c: any) => c[3].reason !== 'verification-ack-pending')).toBe(true);
    expect(writeGateSlot.mock.calls.map((c: any) => c[1].gate)).toEqual(['clarify']);
    expect(writeGateSlot.mock.calls.every((c: any) => c[1].gate !== 'release')).toBe(true);

    // advance_workflow only ever moved Captured->Proposed (plumbing) and Planned->Built (the build
    // gate's own advance) — never into Deployed.
    expect(advanceWorkflow.mock.calls.map((c: any) => c[2].activity)).toEqual(['proposing', 'building']);
  });
});
