// B-732: the release-approval pause, plus a cross-file drift guard binding finish-work's prose to
// the tools that actually exist.
//
// The guard exists because this build hit exactly the failure it catches: the first draft of the
// O2 prose told the agent to call `update_task` with the awaiting_* triple, which update_task does
// not accept. Skill prose that prescribes an impossible call fails only at runtime, in a daemon
// worker, at the release gate — the worst place to discover it.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  flagReleaseApprovalPending,
  flagReleaseApprovalPendingTool,
  RELEASE_APPROVAL_REASON,
} from './release-approval.js';
import { updateTaskTool } from './tasks.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: async (_c: unknown, _p: string, id: string) => `uuid-for-${id}`,
}));

function clientCapturing(captured: { update?: Record<string, unknown>; id?: string }) {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        captured.update = patch;
        return {
          eq: (_col: string, value: string) => {
            captured.id = value;
            return Promise.resolve({ error: null });
          },
        };
      },
    }),
  } as never;
}

describe('flagReleaseApprovalPending', () => {
  it('sets the flag, the release-approval reason, and a ref naming the PR', async () => {
    const captured: { update?: Record<string, unknown>; id?: string } = {};

    const result = await flagReleaseApprovalPending(clientCapturing(captured), 'proj', {
      task_id: 'B-732',
      pr_number: 124,
      pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/124',
    });

    expect(captured.update).toEqual({
      awaiting_human_input: true,
      awaiting_human_reason: 'release-approval-pending',
      awaiting_human_ref: {
        kind: 'release-approval',
        pr_number: 124,
        pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/124',
      },
    });
    expect(captured.id).toBe('uuid-for-B-732');
    expect(result.awaiting_human_reason).toBe(RELEASE_APPROVAL_REASON);
  });

  it('NEVER touches workflow_state — the ticket stays Built until the deploy succeeds', async () => {
    const captured: { update?: Record<string, unknown> } = {};
    await flagReleaseApprovalPending(clientCapturing(captured), 'proj', {
      task_id: 'B-732',
      pr_url: 'https://example.test/pr/1',
    });

    expect(Object.keys(captured.update ?? {})).toEqual([
      'awaiting_human_input',
      'awaiting_human_reason',
      'awaiting_human_ref',
    ]);
  });

  it('requires a PR url, because a pause that does not name what to approve is unactionable', async () => {
    await expect(
      flagReleaseApprovalPending(clientCapturing({}), 'proj', {
        task_id: 'B-732',
        pr_url: '',
      }),
    ).rejects.toThrow(/pr_url is required/);
  });
});

// --- cross-file drift guard: finish-work prose ↔ real tool surface ------------------------------

const finishWorkPath = fileURLToPath(new URL('../../skills/finish-work/SKILL.md', import.meta.url));

describe('finish-work O2 release-approval prose ↔ tool contract (B-732)', () => {
  const prose = readFileSync(finishWorkPath, 'utf8');

  it('the awaiting triple is NOT settable via update_task, so the prose must not tell anyone to try', () => {
    // Guard the guard: if update_task ever gains these fields this assertion fails loudly, and the
    // prose guidance below should be revisited rather than silently left stale.
    const updateTaskFields = Object.keys(updateTaskTool.inputSchema.properties);
    expect(updateTaskFields).not.toContain('awaiting_human_input');
    expect(updateTaskFields).not.toContain('awaiting_human_reason');
    expect(updateTaskFields).not.toContain('awaiting_human_ref');

    expect(prose).not.toMatch(/update_task\([^)]*awaiting_human_input/);
  });

  it('the prose calls the tool that actually exists, by its registered name', () => {
    expect(prose).toContain(flagReleaseApprovalPendingTool.name);
  });

  it('the O2 gate fails CLOSED: it keys on the run marker and hard-errors, never falls through', () => {
    // The whole point of B-732. Gating on the PR author alone fails OPEN precisely when the
    // identity swap breaks, which is the case the gate exists for.
    expect(prose).toContain('HARMONY_BUILD_CONTAINER');
    expect(prose).toMatch(/HARD-ERROR/);
    expect(prose).toMatch(/Never fall\s*\n?\s*through to the merge/);
  });

  it('the gate requires an approving review before the bot-authored merge', () => {
    expect(prose).toContain('reviewDecision');
    expect(prose).toContain('APPROVED');
  });
});

// --- B-732 reopen: the release brief is composed by start-work O3, NOT finish-work O1 ----------
//
// The original AC-3 fix put the approval line in finish-work's O1. The daemon flow never runs it:
// start-work composes the release brief at the end of the build, and finish-work's
// resume-vs-draft check sees Built + not-awaiting + no-active-brief and jumps straight to O2.
// B-738 therefore shipped a release brief with no mention of approval. These assertions pin the
// guidance to the file that actually composes the brief.

const startWorkPath = fileURLToPath(new URL('../../skills/start-work/SKILL.md', import.meta.url));

describe('start-work O3 release-brief ↔ approval requirement (B-732 reopen)', () => {
  const prose = readFileSync(startWorkPath, 'utf8');

  it('instructs querying the PR author + reviewDecision at COMPOSE time', () => {
    expect(prose).toMatch(/gh pr view <pr_number> --json author,reviewDecision/);
  });

  it('makes the approval line conditional on a bot-authored PR', () => {
    expect(prose).toMatch(/author\.is_bot/);
    expect(prose).toMatch(/approval on GitHub/i);
  });

  it('records author_is_bot on build_pr — the field the compose_brief lint keys on', () => {
    expect(prose).toContain('author_is_bot');
  });

  it('no longer asks "to production?" for a merge that deploys to STAGING', () => {
    // B-726(a1) read-plane/deploy-plane conflation: merging to main deploys to staging;
    // production is a separate promote-prod.sh step.
    expect(prose).not.toMatch(/Release <ticket> to production\?/);
    expect(prose).toMatch(/deploy to staging/i);
  });
});
