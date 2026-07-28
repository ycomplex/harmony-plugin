// B-732: the release-approval pause.
//
// Once daemon PRs are authored by the harmony-daemon App, the B-695 merge floor finally engages on
// them: GitHub forbids a PR author approving its own PR, so a bot-authored PR cannot be merged
// until the founder approves it. The worker therefore cannot finish the release leg on its own.
//
// Simply stopping would be a STALL BY DESIGN. The ticket would sit at Built with
// awaiting_human_input false — in nobody's queue — and a GitHub approval touches no ticket row, so
// nothing would ever wake the daemon to retry. This tool closes both ends at once: it puts the
// ticket in the human's queue WITH the PR attached, and its resolution produces the true → false
// flag flip the daemon already wakes on.
//
// WHY A DEDICATED TOOL rather than update_task: the awaiting_* flag triple is a human-pause
// assertion, and every writer of it is the tool whose semantics justify it (compose_brief owns the
// brief pause, file_elicitation_round owns the question pause). Exposing the triple on the general
// update_task would let any caller forge a pause with no corresponding artefact. This is the
// release-approval pause's owner, and it writes NOTHING else — in particular it never touches
// workflow_state, because the ticket legitimately stays at Built until the deploy succeeds.
//
// WHY NOT B-733's elicitation channel: that covers ad-hoc, UNMODELED worker questions improvising a
// channel. A release-approval wait is a MODELED pause with a known shape, so it gets a first-class
// reason and a structured ref the UI can link, rather than a question buried in round prose.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const RELEASE_APPROVAL_REASON = 'release-approval-pending';

export interface FlagReleaseApprovalArgs {
  task_id: string;
  pr_number?: number;
  pr_url: string;
}

export interface FlagReleaseApprovalResult {
  task_id: string;
  awaiting_human_input: true;
  awaiting_human_reason: string;
  awaiting_human_ref: { kind: 'release-approval'; pr_number?: number; pr_url: string };
}

export async function flagReleaseApprovalPending(
  client: SupabaseClient,
  projectId: string,
  args: FlagReleaseApprovalArgs,
): Promise<FlagReleaseApprovalResult> {
  if (!args.pr_url) throw new Error('pr_url is required — the pause must name the PR to approve');

  const taskId = await resolveTaskId(client, projectId, args.task_id);

  const ref = {
    kind: 'release-approval' as const,
    ...(args.pr_number === undefined ? {} : { pr_number: args.pr_number }),
    pr_url: args.pr_url,
  };

  // Idempotent by construction: re-flagging an already-flagged pause rewrites the same triple.
  // A worker that retries the leg must not error here.
  const { error } = await client
    .from('tasks')
    .update({
      awaiting_human_input: true,
      awaiting_human_reason: RELEASE_APPROVAL_REASON,
      awaiting_human_ref: ref,
    })
    .eq('id', taskId);
  if (error) throw new Error(error.message);

  return {
    task_id: taskId,
    awaiting_human_input: true,
    awaiting_human_reason: RELEASE_APPROVAL_REASON,
    awaiting_human_ref: ref,
  };
}

export const flagReleaseApprovalPendingTool = {
  name: 'flag_release_approval_pending',
  description:
    "B-732: pause a release leg on the founder's GitHub approval of a bot-authored PR. Once daemon PRs are authored by the harmony-daemon App, GitHub forbids the author approving its own PR, so the worker cannot merge until a human approves — and a GitHub approval touches no ticket row, so without this the ticket would sit at Built in nobody's queue with nothing to wake the daemon. Sets awaiting_human_input with reason 'release-approval-pending' and an awaiting_human_ref naming the PR, so the ticket enters the human's queue with the PR linked and its resolution produces the true→false flip the daemon wakes on. Never touches workflow_state — the ticket legitimately stays Built until the deploy succeeds. Idempotent: re-flagging rewrites the same triple. Use ONLY for the modeled release-approval pause; an ad-hoc worker question belongs in an elicitation round instead.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
      pr_number: { type: 'number', description: 'The pull request number awaiting approval.' },
      pr_url: {
        type: 'string',
        description:
          'The pull request URL the human must approve. Required — the pause must name what to approve.',
      },
    },
    required: ['task_id', 'pr_url'],
  },
};
