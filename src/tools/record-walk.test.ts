import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  composeBrief: vi.fn(async () => ({ brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } })),
  resolveBrief: vi.fn(async () => ({ status: 'accepted' })),
  consumePendingAcceptanceEvent: vi.fn(async () => ({ status: 'none' as const })),
  writeGateSlot: vi.fn(async (_client: unknown, args: any) => ({ gate: args.gate, applied: true, keys: Object.keys(args.content) })),
  advanceWorkflow: vi.fn(async () => ({ task_id: 't', from_state: 'Planned', to_state: 'Built', activity: 'building', task: {} })),
  addComment: vi.fn(async () => ({ id: 'comment-1' })),
  resolveTaskId: vi.fn(async (_client: unknown, _projectId: string, input: string) => `resolved-${input}`),
}));
const { composeBrief, resolveBrief, consumePendingAcceptanceEvent, writeGateSlot, advanceWorkflow, addComment, resolveTaskId } = mocks;

vi.mock('./briefs.js', () => ({ composeBrief: mocks.composeBrief, resolveBrief: mocks.resolveBrief }));
vi.mock('./acceptance-events.js', () => ({ consumePendingAcceptanceEvent: mocks.consumePendingAcceptanceEvent }));
vi.mock('./gate-slots.js', () => ({ writeGateSlot: mocks.writeGateSlot }));
vi.mock('./workflow.js', () => ({ advanceWorkflow: mocks.advanceWorkflow }));
vi.mock('./comments.js', () => ({ addComment: mocks.addComment }));
vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));

import { runRecordedWalk, RATIFIED_BY_RECORDED, RESOLVE_BRIEF_PROVENANCE_RECORDED, KNOWLEDGE_WRITE_PROVENANCE_RECORDED } from './record-walk.js';
import { PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED } from './provenance.js';

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

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
  advanceWorkflow.mockResolvedValue({ task_id: 't', from_state: 'Planned', to_state: 'Built', activity: 'building', task: {} } as any);
  addComment.mockResolvedValue({ id: 'comment-1' } as any);
  resolveTaskId.mockImplementation(async (_c: unknown, _p: string, input: string) => `resolved-${input}`);
});

describe('runRecordedWalk — refuse-before-write (B-1062)', () => {
  it('an ineligible ticket refuses before any write — the client is never touched', async () => {
    const client = {} as any; // no `.from`/`.rpc` at all — any real call would throw immediately
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: 'Fix the flaky retry timer in the poller.',
      evidence: [{ url: 'https://github.com/ycomplex/harmony-plugin/pull/1', repo: 'ycomplex/harmony-plugin' }],
      // no attest_walk ⇒ item (e) is unattested ⇒ ineligible
    });
    expect(result.refused).toBe(true);
    expect(result.refusal_reason).toContain('Verify walk');
    expect(result.gates).toEqual([]);
    expect(resolveTaskId).not.toHaveBeenCalled();
    expect(composeBrief).not.toHaveBeenCalled();
    expect(resolveBrief).not.toHaveBeenCalled();
    expect(writeGateSlot).not.toHaveBeenCalled();
    expect(advanceWorkflow).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('a multi-repo-ineligible ticket also refuses before any write', async () => {
    const client = {} as any;
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, {
      task_id: 'B-2000',
      summary: 'Fix the flaky retry timer.',
      evidence: [
        { url: 'https://github.com/ycomplex/harmony-plugin/pull/1', repo: 'ycomplex/harmony-plugin' },
        { url: 'https://github.com/ycomplex/harmony-web/pull/2', repo: 'ycomplex/harmony-web' },
      ],
      attest_walk: 'walked it',
    });
    expect(result.refused).toBe(true);
    expect(composeBrief).not.toHaveBeenCalled();
  });
});

describe('runRecordedWalk — the happy path (B-1062)', () => {
  it('walks all six gates in order, using the recorded provenance/ratified_by markers throughout', async () => {
    const client = {} as any;
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build', 'release']);
    expect(result.gates.every((g) => g.landed)).toBe(true);
    expect(result.attestation_recorded).toBe(true);

    // Every resolve_brief accept uses the SAME recorded provenance — never a gate-name/human one.
    expect(resolveBrief).toHaveBeenCalledTimes(5); // clarify, decompose, design, plan, release (build has no brief)
    for (const call of resolveBrief.mock.calls) {
      expect(call[2]).toMatchObject({ command: 'accept', provenance: RESOLVE_BRIEF_PROVENANCE_RECORDED });
    }

    // compose_brief reasons, in order.
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft', 'release-decision-pending',
    ]);

    // The payload-carrying reasons (all but release) each get drained.
    expect(consumePendingAcceptanceEvent).toHaveBeenCalledTimes(4);

    // Both slot-bearing gates (clarify, release) are written DIRECTLY via write_gate_slot, stamped
    // 'recorded' — never the bare gate name a live accept would stamp.
    const slotGates = writeGateSlot.mock.calls.map((c: any) => c[1].gate);
    expect(slotGates).toEqual(['clarify', 'release']);
    for (const call of writeGateSlot.mock.calls) {
      expect(call[1].ratified_by).toBe(RATIFIED_BY_RECORDED);
      expect(call[1].target).toEqual({ via: 'task', task_id: 'resolved-B-2000' });
    }
    // The clarify slot carries the attestation, inline — never only the CLI flag.
    const clarifyCall = writeGateSlot.mock.calls.find((c: any) => c[1].gate === 'clarify')!;
    expect(clarifyCall[1].content.attestation).toBeDefined();
    expect(clarifyCall[1].content.attestation.what_was_walked).toContain('walked the poller');

    // The attestation ALSO lands as a dated ticket comment.
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment.mock.calls[0][3].content).toContain('RECORDED-WALK-ATTESTATION');

    // build is a brief-less advance_workflow('building') — no brief at all.
    expect(advanceWorkflow).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', activity: 'building' });
  });

  it('KNOWLEDGE_WRITE_PROVENANCE_RECORDED is the widened B-1021 agent-on-behalf:human-recorded value', () => {
    expect(KNOWLEDGE_WRITE_PROVENANCE_RECORDED).toBe(PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED);
    expect(KNOWLEDGE_WRITE_PROVENANCE_RECORDED).toBe('agent-on-behalf:human-recorded');
  });
});

describe('runRecordedWalk — mid-walk failure reporting (B-1062)', () => {
  it('reports which gates already landed, never silently half-applying, when a later gate throws', async () => {
    composeBrief.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => {
      if (args.reason === 'plan-draft') throw new Error('boom: plan compose failed');
      return { brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } };
    });
    const client = {} as any;
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.refused).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('boom: plan compose failed');
    expect(result.error).toContain('clarify, decompose, design');
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design']);
    // The failed gate (plan) and everything after it (build, release) never landed.
    expect(result.gates.some((g) => g.gate === 'plan')).toBe(false);
  });

  it('a payload the drain cannot cleanly apply is reported as a mid-walk failure, not a silent skip', async () => {
    consumePendingAcceptanceEvent.mockResolvedValueOnce({ status: 'payload-unrecognized', event_id: 'e-1', reason: 'clarification-draft', items: [] } as any);
    const client = {} as any;
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('clarification-draft');
    expect(result.gates).toEqual([]); // clarify itself failed before pushing its gate result
  });
});
