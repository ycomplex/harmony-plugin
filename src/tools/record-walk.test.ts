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
  recordDecision: vi.fn(async (_c: unknown, _p: string, args: any) => ({ id: `decision-${args.type}-${args.source_activity}`, ...args })),
  queryKnowledge: vi.fn(async () => ([] as any[])),
  referenceKnowledge: vi.fn(async () => ({ linked: true })),
  // B-1073 fast-track release-brief round — the RELEASE section's live `gh pr view` read bottoms out
  // in `node:child_process`'s `execFile`, called via a dynamic `await import(...)` inside
  // record-walk.ts (NOT a static import) — vitest's module mock still intercepts it, since mocks are
  // resolved at the module-graph level, not at the import-statement level. Defaults to an ENOENT-style
  // rejection ('gh: command not found') so every PRE-EXISTING test in this file (none of which know
  // about this round's new gh dependency) keeps degrading to "no clause" exactly like before this
  // round — the regression guard this ticket's spec calls for, satisfied by construction rather than
  // by a dedicated test alone.
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    cb(new Error('gh: command not found'), '');
  }),
}));
const {
  composeBrief, resolveBrief, consumePendingAcceptanceEvent, writeGateSlot, advanceWorkflow, addComment,
  resolveTaskId, manageAcceptanceCriteria, listAcceptanceCriteria, recordDecision, queryKnowledge, referenceKnowledge,
  execFile,
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
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

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

/** A fake Supabase client whose ONLY real-ish behavior is the `tasks` workflow_state read
 *  `runRecordedWalk` now issues directly (B-1062 verify-round fix 1) — everything else in the walk
 *  goes through the mocked module functions above, exactly as before. Defaults to 'Proposed' so the
 *  Captured->Proposed auto-advance does NOT fire unless a test opts in via `workflowState: 'Captured'`. */
function makeClient(workflowState: string | null = 'Proposed') {
  return {
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
}

beforeEach(() => {
  vi.clearAllMocks();
  composeBrief.mockResolvedValue({ brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } } as any);
  resolveBrief.mockResolvedValue({ status: 'accepted' } as any);
  consumePendingAcceptanceEvent.mockResolvedValue({ status: 'none' } as any);
  writeGateSlot.mockImplementation(async (_client: unknown, args: any) => ({ gate: args.gate, applied: true, keys: Object.keys(args.content) }));
  advanceWorkflow.mockImplementation(async (_c: unknown, _p: string, args: any) => ({ task_id: 't', from_state: 'Planned', to_state: 'Built', activity: args.activity, task: {} }));
  addComment.mockResolvedValue({ id: 'comment-1' } as any);
  resolveTaskId.mockImplementation(async (_c: unknown, _p: string, input: string) => `resolved-${input}`);
  manageAcceptanceCriteria.mockResolvedValue({ added: [{ id: 'ac-1' }], updated: [], deleted: [] } as any);
  listAcceptanceCriteria.mockResolvedValue([{ id: 'ac-1', content: 'the recorded AC', checked: true, position: 0, created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' }] as any);
  recordDecision.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => ({ id: `decision-${args.type}-${args.source_activity}`, ...args }));
  queryKnowledge.mockResolvedValue([] as any[]);
  referenceKnowledge.mockResolvedValue({ linked: true } as any);
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    cb(new Error('gh: command not found'), '');
  });
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
    expect(manageAcceptanceCriteria).not.toHaveBeenCalled();
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
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'deploy', 'verify']);
    expect(result.gates.every((g) => g.landed)).toBe(true);
    expect(result.attestation_recorded).toBe(true);

    // Every resolve_brief accept uses the SAME recorded provenance — never a gate-name/human one.
    // Still exactly 5: clarify, decompose, design, plan, release (build has no brief; verify is
    // COMPOSED but never accepted — see the dedicated describe block below for that assertion).
    expect(resolveBrief).toHaveBeenCalledTimes(5);
    for (const call of resolveBrief.mock.calls) {
      expect(call[2]).toMatchObject({ command: 'accept', provenance: RESOLVE_BRIEF_PROVENANCE_RECORDED });
    }

    // compose_brief reasons, in order — including the new verify compose at the end.
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
      'release-decision-pending', 'verification-ack-pending',
    ]);

    // The payload-carrying reasons (all but release/verify) each get drained.
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

    // No Captured->Proposed advance on an already-Proposed ticket.
    expect(advanceWorkflow.mock.calls.some((c: any) => c[2].activity === 'proposing')).toBe(false);

    // deploy is a brief-less advance_workflow('deploying') — no brief, mirrors build.
    expect(advanceWorkflow).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', activity: 'deploying' });
  });

  it('KNOWLEDGE_WRITE_PROVENANCE_RECORDED is the widened B-1021 agent-on-behalf:human-recorded value', () => {
    expect(KNOWLEDGE_WRITE_PROVENANCE_RECORDED).toBe(PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED);
    expect(KNOWLEDGE_WRITE_PROVENANCE_RECORDED).toBe('agent-on-behalf:human-recorded');
  });
});

describe('runRecordedWalk — advances to Deployed and composes (never accepts) the verify brief (B-1062 round 2)', () => {
  it('advances Built->Deployed via advance_workflow, brief-less, like build', async () => {
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(advanceWorkflow).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', activity: 'deploying' });
  });

  it('composes the verify brief with reason verification-ack-pending and pending_activity verifying', async () => {
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    const verifyCall = composeBrief.mock.calls.find((c: any) => c[3].reason === 'verification-ack-pending');
    expect(verifyCall).toBeDefined();
    const composeArgs = verifyCall![3];
    expect(composeArgs.pending_activity).toBe('verifying');
    expect(composeArgs.task_id).toBe('resolved-B-2000');
    expect(composeArgs.doc.frame).toMatchObject({ kind: 'verify', environment: 'merged-main' });
    // manifest_root is deliberately omitted — this layer has no notion of "the repo of record".
    expect(composeArgs.manifest_root).toBeUndefined();
  });

  it('reads the ticket\'s CURRENT acceptance criteria (via list_acceptance_criteria) onto the verify frame\'s criteria ledger', async () => {
    listAcceptanceCriteria.mockResolvedValueOnce([
      { id: 'ac-1', content: 'the recorded AC', checked: true, position: 0, created_by: USER_ID, created_at: '2026-01-01T00:00:00Z' },
      { id: 'ac-2', content: 'a second AC', checked: false, position: 1, created_by: USER_ID, created_at: '2026-01-01T00:00:00Z' },
    ] as any);
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(listAcceptanceCriteria).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000' });
    const verifyCall = composeBrief.mock.calls.find((c: any) => c[3].reason === 'verification-ack-pending')!;
    const criteria = verifyCall[3].doc.frame.criteria;
    expect(criteria).toEqual([
      { ac_id: 'ac-1', text: 'the recorded AC', checked: true, disposition: 'walk', step_ref: '1' },
      { ac_id: 'ac-2', text: 'a second AC', checked: false, disposition: 'walk', step_ref: '1' },
    ]);
  });

  it("B-1068 — the composed verify frame's own `steps` satisfy the real lintBrief's runbook-integrity checks", async () => {
    // `./briefs.js` is mocked wholesale in this file (composeBrief/resolveBrief are fakes) — reach past
    // the mock for the REAL renderBrief/lintBrief so this is a genuine check against the shipped lint,
    // not a hand-rolled reimplementation of it that could drift from the real rules.
    const real = await vi.importActual<typeof import('./briefs.js')>('./briefs.js');
    listAcceptanceCriteria.mockResolvedValueOnce([
      { id: 'ac-1', content: 'the recorded AC', checked: true, position: 0, created_by: USER_ID, created_at: '2026-01-01T00:00:00Z' },
      { id: 'ac-2', content: 'a second AC', checked: false, position: 1, created_by: USER_ID, created_at: '2026-01-01T00:00:00Z' },
    ] as any);
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    const verifyCall = composeBrief.mock.calls.find((c: any) => c[3].reason === 'verification-ack-pending')!;
    const doc = verifyCall[3].doc;
    const md = real.renderBrief(doc, null, { reason: 'verification-ack-pending' });
    const lint = real.lintBrief(doc, md, { reason: 'verification-ack-pending' });
    expect(lint.errors).toEqual([]);
    expect(lint.ok).toBe(true);
    // and the walk really does render, above the criteria table
    expect(md).toContain('**Walk**');
    expect(md.indexOf('**Walk**')).toBeLessThan(md.indexOf('**Verifying against'));
  });

  it('the verify brief is COMPOSED but NEVER accepted — resolve_brief is never called for it', async () => {
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    // Exactly 5 resolve_brief calls total (clarify, decompose, design, plan, release) — none for verify.
    expect(resolveBrief).toHaveBeenCalledTimes(5);
    // consume_pending_acceptance_event is never called for verify either (it mints no event, like release).
    expect(consumePendingAcceptanceEvent).toHaveBeenCalledTimes(4);
  });

  it('the returned gates array reports deploy and verify landed, in order, after release', async () => {
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.gates).toContainEqual({ gate: 'deploy', landed: true });
    expect(result.gates).toContainEqual({ gate: 'verify', reason: 'verification-ack-pending', landed: true });
    const gateNames = result.gates.map((g) => g.gate);
    expect(gateNames.indexOf('release')).toBeLessThan(gateNames.indexOf('deploy'));
    expect(gateNames.indexOf('deploy')).toBeLessThan(gateNames.indexOf('verify'));
  });
});

describe('runRecordedWalk — Captured ticket auto-advances proposing before clarify (B-1062 fix 1)', () => {
  it('a Captured ticket is advanced Captured->Proposed BEFORE clarify composes, mirroring harmony-conduct\'s own plumbing advance', async () => {
    const client = makeClient('Captured');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'deploy', 'verify']);

    // The proposing advance happened, brief-less, exactly like the conductor's own Captured self-advance.
    expect(advanceWorkflow).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', activity: 'proposing' });

    // It happened BEFORE clarify's compose_brief — ordering matters (compose_brief would otherwise
    // refuse: no ('Captured','clarifying','Clarified') transition edge exists).
    const proposingCallOrder = advanceWorkflow.mock.invocationCallOrder[
      advanceWorkflow.mock.calls.findIndex((c: any) => c[2].activity === 'proposing')
    ];
    const clarifyComposeOrder = composeBrief.mock.invocationCallOrder[
      composeBrief.mock.calls.findIndex((c: any) => c[3].reason === 'clarification-draft')
    ];
    expect(proposingCallOrder).toBeLessThan(clarifyComposeOrder);
  });

  it('a Proposed (or later) ticket never triggers the proposing advance', async () => {
    const client = makeClient('Clarified');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(advanceWorkflow.mock.calls.some((c: any) => c[2].activity === 'proposing')).toBe(false);
  });
});

describe('runRecordedWalk — files a build-gate-satisfying acceptance criterion at clarify (B-1062 fix 2)', () => {
  it('files exactly one CHECKED acceptance criterion, before decompose, naming the recorded origin', async () => {
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.error).toBeUndefined();
    expect(manageAcceptanceCriteria).toHaveBeenCalledTimes(1);
    const [, , acUserId, acArgs] = manageAcceptanceCriteria.mock.calls[0];
    expect(acUserId).toBe(USER_ID);
    expect(acArgs.task_id).toBe('resolved-B-2000');
    expect(acArgs.add).toHaveLength(1);
    expect(acArgs.add[0].checked).toBe(true);
    expect(acArgs.add[0].content).toContain('Fix the flaky retry timer in the poller');
    expect(acArgs.add[0].content).toContain('https://github.com/ycomplex/harmony-plugin/pull/1');
    expect(acArgs.add[0].content).toContain(USER_ID); // "verify walk attested by <who>"

    // Filed before decompose's compose_brief (B-747 floor must be satisfied before the walk proceeds).
    const acCallOrder = manageAcceptanceCriteria.mock.invocationCallOrder[0];
    const decomposeComposeOrder = composeBrief.mock.invocationCallOrder[
      composeBrief.mock.calls.findIndex((c: any) => c[3].reason === 'decomposition-proposal')
    ];
    expect(acCallOrder).toBeLessThan(decomposeComposeOrder);
  });
});

describe('runRecordedWalk — attestation carries a populated who (B-1062 fix 4, AC c44227c9)', () => {
  it('the clarify gate slot\'s attestation JSON carries who/what_was_walked/when/evidence, who populated from the acting user', async () => {
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    const clarifyCall = writeGateSlot.mock.calls.find((c: any) => c[1].gate === 'clarify')!;
    const attestation = clarifyCall[1].content.attestation;
    expect(attestation.who).toBe(USER_ID);
    expect(attestation.what_was_walked).toContain('walked the poller');
    expect(attestation.when).toBeDefined();
    expect(attestation.evidence).toEqual(['https://github.com/ycomplex/harmony-plugin/pull/1']);
  });

  it('the RECORDED-WALK-ATTESTATION ticket comment renders separate who/what_was_walked/when lines', async () => {
    const client = makeClient('Proposed');
    await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    const commentBody = addComment.mock.calls[0][3].content as string;
    expect(commentBody).toContain(`who: ${USER_ID}`);
    expect(commentBody).toContain('what_was_walked: walked the poller locally');
    expect(commentBody).toMatch(/when: \d{4}-\d{2}-\d{2}T/);
  });
});

describe('runRecordedWalk — mints/couples the same knowledge-entry shape a conducted gate would (B-1062 fix-forward round 3)', () => {
  it('records and couples a knowledge entry at clarify, decompose (no-split create path), design, and plan', async () => {
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.error).toBeUndefined();

    // Exactly 4 mints: clarify, decompose's shared convention (create path — queryKnowledge returns
    // [] by default in beforeEach), design, plan.
    expect(recordDecision).toHaveBeenCalledTimes(4);
    const pairs = recordDecision.mock.calls.map((c: any) => [c[3].type, c[3].source_activity]);
    expect(pairs).toEqual([
      ['specification', 'clarify'],
      ['convention', 'decompose'],
      ['technical-design', 'design-decide'],
      ['specification', 'plan'],
    ]);
    for (const call of recordDecision.mock.calls) {
      expect(call[3].provenance).toBe(KNOWLEDGE_WRITE_PROVENANCE_RECORDED);
    }

    // Every minted/coupled entry is referenced onto the resolved task_id, in gate order.
    expect(referenceKnowledge).toHaveBeenCalledTimes(4);
    const refCalls = referenceKnowledge.mock.calls.map((c: any) => c[2]);
    expect(refCalls).toEqual([
      { task_id: 'resolved-B-2000', decision_id: 'decision-specification-clarify' },
      { task_id: 'resolved-B-2000', decision_id: 'decision-convention-decompose' },
      { task_id: 'resolved-B-2000', decision_id: 'decision-technical-design-design-decide' },
      { task_id: 'resolved-B-2000', decision_id: 'decision-specification-plan' },
    ]);

    const composeCalls = composeBrief.mock.calls;
    const clarifyCompose = composeCalls.find((c: any) => c[3].reason === 'clarification-draft')!;
    const decomposeCompose = composeCalls.find((c: any) => c[3].reason === 'decomposition-proposal')!;
    const designCompose = composeCalls.find((c: any) => c[3].reason === 'design-decision-draft')!;
    const planCompose = composeCalls.find((c: any) => c[3].reason === 'plan-draft')!;

    // clarify/design/plan carry a decision_ref matching what recordDecision returned for that gate.
    expect(clarifyCompose[3].decision_ref).toEqual({ type: 'specification', id: 'decision-specification-clarify' });
    expect(designCompose[3].decision_ref).toEqual({ type: 'technical-design', id: 'decision-technical-design-design-decide' });
    expect(planCompose[3].decision_ref).toEqual({ type: 'specification', id: 'decision-specification-plan' });

    // decompose's no-split shape never sets a decision_ref — mirrors the live no-split skill exactly.
    expect(decomposeCompose[3].decision_ref).toBeUndefined();

    // Only plan-draft carries a hand-authored payload (compose_brief does not auto-derive it).
    expect(planCompose[3].doc.payload).toHaveLength(1);
    const planPayloadItem = planCompose[3].doc.payload[0];
    expect(planPayloadItem.write_kind).toBe('knowledge_entry_content');
    expect(planPayloadItem.entry_id).toBe('decision-specification-plan');
    expect(planPayloadItem.content).toBeTruthy();

    // clarify/design are auto-derived by compose_brief — never hand-authored here.
    expect(clarifyCompose[3].doc.payload).toEqual([]);
    expect(designCompose[3].doc.payload).toEqual([]);
  });

  it('couples the EXISTING shared no-split convention entry without minting a new one when queryKnowledge finds it', async () => {
    queryKnowledge.mockResolvedValueOnce([{
      id: 'existing-convention-1',
      title: 'Decompose: when a ticket does not split',
      type: 'convention',
      status: 'Accepted',
      domain: [],
      tags: ['decompose-no-split'],
      project_id: null,
      updated_at: '2026-01-01T00:00:00Z',
    }] as any);
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.error).toBeUndefined();
    expect(recordDecision.mock.calls.some((c: any) => c[3].type === 'convention')).toBe(false);
    expect(referenceKnowledge).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', decision_id: 'existing-convention-1' });
  });
});

describe('runRecordedWalk — mid-walk failure reporting (B-1062)', () => {
  it('reports which gates already landed, never silently half-applying, when a later gate throws', async () => {
    composeBrief.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => {
      if (args.reason === 'plan-draft') throw new Error('boom: plan compose failed');
      return { brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } };
    });
    const client = makeClient('Proposed');
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
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('clarification-draft');
    expect(result.gates).toEqual([]); // clarify itself failed before pushing its gate result
  });

  it('a thrown PostgrestError-shaped plain object (NOT an Error instance) yields its .message, never [object Object] (B-1062 fix 3)', async () => {
    const postgrestError = {
      message: 'duplicate key value violates unique constraint',
      code: '23505',
      details: null,
      hint: null,
    };
    expect(postgrestError).not.toBeInstanceOf(Error);
    composeBrief.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => {
      if (args.reason === 'plan-draft') throw postgrestError;
      return { brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } };
    });
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.error).toBeDefined();
    expect(result.error).toContain('duplicate key value violates unique constraint');
    expect(result.error).not.toContain('[object Object]');
  });

  it('a thrown value with no .message at all falls back to JSON.stringify, never [object Object]', async () => {
    composeBrief.mockImplementation(async (_c: unknown, _p: string, _u: string, args: any) => {
      if (args.reason === 'plan-draft') throw { code: 'PGRST000', details: 'no message field here' };
      return { brief: { id: 'brief-1' }, lint: { ok: true, errors: [], warnings: [] } };
    });
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());

    expect(result.error).toBeDefined();
    expect(result.error).not.toContain('[object Object]');
    expect(result.error).toContain('PGRST000');
  });

  it('the Captured->Proposed workflow_state read itself failing is reported as a mid-walk failure before any gate lands', async () => {
    const client = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: 'task row not found', code: 'PGRST116' } }),
            }),
          }),
        }),
      })),
    } as any;
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('task row not found');
    expect(result.gates).toEqual([]);
    expect(composeBrief).not.toHaveBeenCalled();
  });
});

describe('runRecordedWalk — from_gate (B-1073 step 9/10)', () => {
  it('omitted from_gate behaves exactly as before — every gate still lands, in order', async () => {
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'deploy', 'verify']);
  });

  it("from_gate: 'deploy' on an already-Built fixture skips clarify/decompose/design/plan/build and lands only deploy + the verify brief", async () => {
    const client = makeClient('Built');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, { ...eligibleArgs(), from_gate: 'deploy' });

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['deploy', 'verify']);

    // No brief composed for any of the five skipped gates — only the verify compose.
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual(['verification-ack-pending']);
    expect(resolveBrief).not.toHaveBeenCalled();
    expect(consumePendingAcceptanceEvent).not.toHaveBeenCalled();

    // No gate slot written — clarify/release (the two slot-writing gates) are both skipped.
    expect(writeGateSlot).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(manageAcceptanceCriteria).not.toHaveBeenCalled();
    expect(recordDecision).not.toHaveBeenCalled();

    // The ONLY advance_workflow call is the deploy gate's own brief-less Built->Deployed advance —
    // never 'proposing' (ticket is already past Captured) and never 'building' (skipped).
    expect(advanceWorkflow).toHaveBeenCalledTimes(1);
    expect(advanceWorkflow).toHaveBeenCalledWith(client, PROJECT_ID, { task_id: 'resolved-B-2000', activity: 'deploying' });
  });

  it("from_gate: 'build' skips clarify/decompose/design/plan and lands build onward", async () => {
    const client = makeClient('Planned');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, { ...eligibleArgs(), from_gate: 'build' });
    expect(result.gates.map((g) => g.gate)).toEqual(['build', 'release', 'deploy', 'verify']);
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual(['release-decision-pending', 'verification-ack-pending']);
  });
});

describe('runRecordedWalk — to_gate (B-1073 fast-track-daemon-ending round)', () => {
  it("to_gate: 'build' from a fresh Captured ticket lands exactly clarify..build, leaves workflow_state " +
     'at Built (via the build gate\'s own advance_workflow call), writes no release/deploy/verify brief ' +
     'or gate slot, and reports stopped_at_gate', async () => {
    const client = makeClient('Captured');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, { ...eligibleArgs(), to_gate: 'build' });

    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build']);
    expect(result.stopped_at_gate).toBe('build');

    // No release/deploy/verify-shaped write landed — composeBrief only ran for the four reasons
    // clarify/decompose/design/plan actually use (build itself is a bare advance_workflow, no brief).
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual([
      'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
    ]);
    // write_gate_slot ran once, for clarify only — release's own write_gate_slot call never fires.
    expect(writeGateSlot.mock.calls.map((c: any) => c[1].gate)).toEqual(['clarify']);
    // advance_workflow ran for the Captured->Proposed plumbing AND the build gate's own advance —
    // never 'deploying' (deploy is past the bound).
    expect(advanceWorkflow.mock.calls.map((c: any) => c[2].activity)).toEqual(['proposing', 'building']);
  });

  it('to_gate omitted still behaves exactly as today — full walk to verify, stopped_at_gate undefined ' +
     '(a regression guard)', async () => {
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, eligibleArgs());
    expect(result.gates.map((g) => g.gate)).toEqual(['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'deploy', 'verify']);
    expect(result.stopped_at_gate).toBeUndefined();
  });

  it("from_gate: 'plan' + to_gate: 'build' together lands only plan and build", async () => {
    const client = makeClient('Designed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, { ...eligibleArgs(), from_gate: 'plan', to_gate: 'build' });
    expect(result.gates.map((g) => g.gate)).toEqual(['plan', 'build']);
    expect(result.stopped_at_gate).toBe('build');
    expect(composeBrief.mock.calls.map((c: any) => c[3].reason)).toEqual(['plan-draft']);
  });

  it('a degenerate bound (to_gate precedes from_gate) lands zero gates, writes nothing beyond the ' +
     'Captured->Proposed plumbing, and never throws — documented choice: every gate\'s runs() guard ' +
     'reads false when toGate\'s index < fromGate\'s index, so the walk completes with an empty ' +
     '`gates` array rather than refusing or erroring', async () => {
    const client = makeClient('Captured');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, { ...eligibleArgs(), from_gate: 'build', to_gate: 'clarify' });
    expect(result.refused).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.gates).toEqual([]);
    expect(result.stopped_at_gate).toBe('clarify');
    expect(composeBrief).not.toHaveBeenCalled();
    expect(writeGateSlot).not.toHaveBeenCalled();
    // Only the Captured->Proposed plumbing advance fires — no gate section runs.
    expect(advanceWorkflow.mock.calls.map((c: any) => c[2].activity)).toEqual(['proposing']);
  });
});

describe('runRecordedWalk — RELEASE: bot-authored evidence PR disclosure (B-1073 fast-track round)', () => {
  /** A fake `execFile` that answers `gh pr view <number> --repo <repoSlug> --json ...` for exactly
   *  the PR named by `evidenceUrl`, and rejects (ENOENT-style) for anything else. */
  function mockGhPrView(evidenceUrl: string, data: Record<string, unknown>) {
    execFile.mockImplementation((_cmd: string, cmdArgs: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
      if (cmdArgs[0] === 'pr' && cmdArgs[1] === 'view') {
        cb(null, JSON.stringify(data));
      } else {
        cb(new Error('gh: unexpected invocation in test'), '');
      }
    });
  }

  const botPrEvidence = () => ({
    task_id: 'B-2000',
    summary: 'Fix the flaky retry timer in the poller.',
    evidence: [{ url: 'https://github.com/ycomplex/harmony-web/pull/529', repo: 'ycomplex/harmony-web' }],
    attest_walk: 'walked the poller locally for 8 minutes, confirmed the retry timer no longer flakes',
  });

  function releaseComposeCall() {
    const call = composeBrief.mock.calls.find((c: any) => c[3].reason === 'release-decision-pending');
    expect(call).toBeDefined();
    return call![3];
  }

  it('a bot-authored, ALREADY-MERGED evidence PR gets the merged-not-approval-needed clause, and compose/lint succeeds', async () => {
    mockGhPrView('https://github.com/ycomplex/harmony-web/pull/529', {
      author: { is_bot: true },
      mergedAt: '2026-10-01T12:00:00Z',
      reviewDecision: null,
    });

    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, botPrEvidence());

    expect(result.error).toBeUndefined();
    expect(result.refused).toBe(false);
    expect(result.gates.map((g) => g.gate)).toContain('release');

    const releaseArgs = releaseComposeCall();
    expect(releaseArgs.doc.context).toBeDefined();
    const clause = releaseArgs.doc.context.join(' ');
    expect(clause).toContain('https://github.com/ycomplex/harmony-web/pull/529');
    expect(clause).toMatch(/already MERGED/);
    expect(clause).toMatch(/no GitHub approval is needed/);

    // The gh call read the SAME fields finish-work's own O1 step reads, widened with mergedAt.
    const prViewCall = execFile.mock.calls.find((c: any) => c[1][0] === 'pr' && c[1][1] === 'view');
    expect(prViewCall![1]).toEqual(
      expect.arrayContaining(['--repo', 'ycomplex/harmony-web', '--json', 'author,mergedAt,reviewDecision']),
    );
  });

  it('a bot-authored, NOT-yet-merged evidence PR gets the approval-required clause with the live reviewDecision', async () => {
    mockGhPrView('https://github.com/ycomplex/harmony-web/pull/529', {
      author: { is_bot: true },
      mergedAt: null,
      reviewDecision: 'REVIEW_REQUIRED',
    });

    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, botPrEvidence());

    expect(result.error).toBeUndefined();
    const releaseArgs = releaseComposeCall();
    const clause = releaseArgs.doc.context.join(' ');
    expect(clause).toContain('https://github.com/ycomplex/harmony-web/pull/529');
    expect(clause).toMatch(/needs your approval on GitHub/);
    expect(clause).toContain('REVIEW_REQUIRED');
    expect(clause.toLowerCase()).toContain('reviewdecision');
  });

  it('gh-unavailable (or a non-PR-URL evidence entry) degrades to no clause — the walk still succeeds', async () => {
    // execFile's default (set in beforeEach) already rejects every call — simulating `gh` missing.
    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, botPrEvidence());

    expect(result.error).toBeUndefined();
    expect(result.refused).toBe(false);
    expect(result.gates.map((g) => g.gate)).toContain('release');

    const releaseArgs = releaseComposeCall();
    expect(releaseArgs.doc.context).toBeUndefined();
  });

  it('a non-bot-authored evidence PR gets no clause either, even when gh IS available', async () => {
    mockGhPrView('https://github.com/ycomplex/harmony-web/pull/529', {
      author: { is_bot: false },
      mergedAt: '2026-10-01T12:00:00Z',
      reviewDecision: null,
    });

    const client = makeClient('Proposed');
    const result = await runRecordedWalk(client, PROJECT_ID, USER_ID, botPrEvidence());

    expect(result.error).toBeUndefined();
    const releaseArgs = releaseComposeCall();
    expect(releaseArgs.doc.context).toBeUndefined();
  });
});
