// B-734 Phase B: the release-evidence pause.
//
// The load-bearing property here is ANTI-FORGERY, so the tests assert the update PAYLOAD SHAPE, not
// just that a write happened: this tool exists precisely so the awaiting_* triple is written only by
// a tool whose semantics justify it, and it must write nothing else — in particular never
// workflow_state, which would silently move a ticket whose release did not happen.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  flagReleaseEvidenceMissing,
  flagReleaseEvidenceMissingTool,
  RELEASE_EVIDENCE_REASON,
} from './release-evidence.js';
import { flagReleaseApprovalPendingTool } from './release-approval.js';
import { updateTaskTool } from './tasks.js';
import { registerTools } from './index.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: async (_c: unknown, _p: string, id: string) => `uuid-for-${id}`,
}));

/** Captures every update patch in call order, so idempotency can be asserted on the SECOND write. */
function clientCapturing(captured: { updates: Record<string, unknown>[]; ids: string[] }) {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        captured.updates.push(patch);
        return {
          eq: (_col: string, value: string) => {
            captured.ids.push(value);
            return Promise.resolve({ error: null });
          },
        };
      },
    }),
  } as never;
}

function capture() {
  return { updates: [] as Record<string, unknown>[], ids: [] as string[] };
}

describe('flagReleaseEvidenceMissing (B-734)', () => {
  it('sets the flag, the release-evidence reason, and a ref naming the brief whose entry is absent', async () => {
    const captured = capture();

    const result = await flagReleaseEvidenceMissing(clientCapturing(captured), 'proj', {
      task_id: 'B-734',
      brief_id: 'bbbbbbbb-0000-0000-0000-000000000001',
      task_visual_id: 'B-734',
    });

    expect(captured.updates[0]).toEqual({
      awaiting_human_input: true,
      awaiting_human_reason: 'release-evidence-missing',
      awaiting_human_ref: {
        kind: 'release-evidence',
        brief_id: 'bbbbbbbb-0000-0000-0000-000000000001',
        task_visual_id: 'B-734',
      },
    });
    expect(captured.ids[0]).toBe('uuid-for-B-734');
    expect(result.awaiting_human_reason).toBe(RELEASE_EVIDENCE_REASON);
    expect(result.awaiting_human_input).toBe(true);
    expect(result.task_id).toBe('uuid-for-B-734');
  });

  it('writes EXACTLY the three awaiting_* columns and nothing else (the anti-forgery property)', async () => {
    const captured = capture();
    await flagReleaseEvidenceMissing(clientCapturing(captured), 'proj', { task_id: 'B-734' });

    expect(Object.keys(captured.updates[0])).toEqual([
      'awaiting_human_input',
      'awaiting_human_reason',
      'awaiting_human_ref',
    ]);
  });

  it('NEVER touches workflow_state — the ticket legitimately stays Built, the release did not happen', async () => {
    const captured = capture();
    await flagReleaseEvidenceMissing(clientCapturing(captured), 'proj', { task_id: 'B-734' });

    expect(captured.updates[0]).not.toHaveProperty('workflow_state');
    expect(captured.updates[0]).not.toHaveProperty('workflow_activity');
    expect(captured.updates[0]).not.toHaveProperty('status');
  });

  it('omits absent optional ref fields rather than emitting nulls', async () => {
    const captured = capture();
    await flagReleaseEvidenceMissing(clientCapturing(captured), 'proj', { task_id: 'B-734' });

    expect(captured.updates[0].awaiting_human_ref).toEqual({ kind: 'release-evidence' });

    const captured2 = capture();
    await flagReleaseEvidenceMissing(clientCapturing(captured2), 'proj', {
      task_id: 'B-734',
      brief_id: 'brief-9',
    });
    expect(captured2.updates[0].awaiting_human_ref).toEqual({
      kind: 'release-evidence',
      brief_id: 'brief-9',
    });
  });

  it('is IDEMPOTENT: re-flagging rewrites the same triple and does not error', async () => {
    const captured = capture();
    const args = { task_id: 'B-734', brief_id: 'brief-9' };
    const client = clientCapturing(captured);

    const first = await flagReleaseEvidenceMissing(client, 'proj', args);
    const second = await flagReleaseEvidenceMissing(client, 'proj', args);

    expect(second).toEqual(first);
    expect(captured.updates).toHaveLength(2);
    expect(captured.updates[1]).toEqual(captured.updates[0]);
    expect(captured.ids).toEqual(['uuid-for-B-734', 'uuid-for-B-734']);
  });

  it('requires a task_id — there is no pause without a ticket to pause', async () => {
    await expect(
      flagReleaseEvidenceMissing(clientCapturing(capture()), 'proj', { task_id: '' }),
    ).rejects.toThrow(/task_id is required/);
  });

  it('surfaces a DB error rather than reporting a pause that was never written', async () => {
    const client = {
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: { message: 'permission denied for table tasks' } }) }),
      }),
    } as never;
    await expect(
      flagReleaseEvidenceMissing(client, 'proj', { task_id: 'B-734' }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('flag_release_evidence_missing tool contract (B-734)', () => {
  it('pins the tool name and reason string — skill prose references these verbatim', () => {
    expect(flagReleaseEvidenceMissingTool.name).toBe('flag_release_evidence_missing');
    expect(RELEASE_EVIDENCE_REASON).toBe('release-evidence-missing');
  });

  it('is REGISTERED, so the pause is actually reachable from a worker', () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('flag_release_evidence_missing');
    // Its sibling stays registered too — this is an addition, not a swap.
    expect(names).toContain(flagReleaseApprovalPendingTool.name);
  });

  it('requires only task_id; the ref fields that identify the missing decision are optional', () => {
    expect(flagReleaseEvidenceMissingTool.inputSchema.required).toEqual(['task_id']);
    expect(Object.keys(flagReleaseEvidenceMissingTool.inputSchema.properties)).toEqual([
      'task_id',
      'brief_id',
      'task_visual_id',
    ]);
  });

  it('the awaiting triple is still NOT settable via update_task — this tool is the only writer', () => {
    // Guard the guard (mirrors release-approval.test.ts): if update_task ever gains these fields the
    // dedicated-writer doctrine has been broken somewhere else and this fails loudly.
    const updateTaskFields = Object.keys(updateTaskTool.inputSchema.properties);
    expect(updateTaskFields).not.toContain('awaiting_human_input');
    expect(updateTaskFields).not.toContain('awaiting_human_reason');
    expect(updateTaskFields).not.toContain('awaiting_human_ref');
  });
});

// --- cross-file drift guard: finish-work prose ↔ real tool surface ------------------------------
//
// Same guard release-approval.test.ts carries, for the same reason: skill prose that prescribes a
// call which does not exist fails only at runtime, in a daemon worker, at the release gate.

const finishWorkPath = fileURLToPath(new URL('../../skills/finish-work/SKILL.md', import.meta.url));

describe('finish-work O1 release-evidence prose ↔ tool contract (B-734)', () => {
  const prose = readFileSync(finishWorkPath, 'utf8');

  it('the prose calls the tool that actually exists, by its registered name', () => {
    expect(prose).toContain(flagReleaseEvidenceMissingTool.name);
  });

  it('the prose names the reason string the tool actually writes', () => {
    expect(prose).toContain(RELEASE_EVIDENCE_REASON);
  });

  it('the prose never routes the awaiting triple through update_task', () => {
    expect(prose).not.toMatch(/update_task\([^)]*awaiting_human_input/);
  });
});
