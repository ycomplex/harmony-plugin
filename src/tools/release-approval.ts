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
  /** B-745: the PR's current `gh pr view --json reviewDecision` value at flag time (e.g.
   *  'APPROVED', 'CHANGES_REQUESTED', or absent/null pre-review). Threaded through UNCONDITIONALLY
   *  on every call — this tool is a stateless writer with no way to know "is this a repeat flag",
   *  so nothing here is gated on repeat-vs-first-call. Recording it lets the human (and the web
   *  half's UI) see the review state that was true at the moment the pause was (re)written, without
   *  a second GitHub round-trip. */
  review_decision?: string;
}

export interface FlagReleaseApprovalResult {
  task_id: string;
  awaiting_human_input: true;
  awaiting_human_reason: string;
  awaiting_human_ref: { kind: 'release-approval'; pr_number?: number; pr_url: string; review_decision?: string };
}

// B-1071: defense in depth against stomping an ACTIVE brief's visibility. The 2026-09-24 incident:
// a verify send-back fixed forward from Deployed by opening a PR and calling this tool WHILE the
// ticket's verify-send-back brief was still active — overwriting the awaiting_* triple out from
// under it and hiding that brief from the human. The documented (and now mandatory — see
// skills/finish-work/SKILL.md) fix-forward pattern avoids this by ALWAYS resolving the ticket's own
// release brief before this tool ever runs, but this guard exists so a future code path that skips
// that rule fails safe instead of silently stomping.
//
// The predicate below is copy-verbatim from composeBrief's own active-brief lookup (briefs.ts:
// `.eq('task_id', taskId).eq('status', 'active').maybeSingle()`) — deliberately, so this guard and
// the writer it is guarding against always agree on what "active" means. It does NOT key off
// `awaiting_human_ref.type`: that is a projection on the TASK row, not the brief row, and cannot
// reliably distinguish a still-open brief from a modeled non-brief pause (e.g. an elicitation round)
// — only the briefs table itself can answer "is a brief active right now".
export interface FlagReleaseApprovalRefusal {
  refused: true;
  reason: 'active-brief';
  active_brief: { id: string; reason: string; iteration?: number };
  task_id: string;
}

export async function flagReleaseApprovalPending(
  client: SupabaseClient,
  projectId: string,
  args: FlagReleaseApprovalArgs,
): Promise<FlagReleaseApprovalResult | FlagReleaseApprovalRefusal> {
  if (!args.pr_url) throw new Error('pr_url is required — the pause must name the PR to approve');

  const taskId = await resolveTaskId(client, projectId, args.task_id);

  const { data: activeBrief, error: briefErr } = await client
    .from('briefs')
    .select('id, reason, iteration')
    .eq('task_id', taskId)
    .eq('status', 'active')
    .maybeSingle();
  if (briefErr) throw new Error(briefErr.message);

  if (activeBrief) {
    const row = activeBrief as { id: string; reason: string; iteration?: number };
    return {
      refused: true,
      reason: 'active-brief',
      active_brief: { id: row.id, reason: row.reason, iteration: row.iteration },
      task_id: taskId,
    };
  }

  const ref = {
    kind: 'release-approval' as const,
    ...(args.pr_number === undefined ? {} : { pr_number: args.pr_number }),
    pr_url: args.pr_url,
    ...(args.review_decision === undefined ? {} : { review_decision: args.review_decision }),
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
    "B-732: pause a release leg on the founder's GitHub approval of a bot-authored PR. Once daemon PRs are authored by the harmony-daemon App, GitHub forbids the author approving its own PR, so the worker cannot merge until a human approves — and a GitHub approval touches no ticket row, so without this the ticket would sit at Built in nobody's queue with nothing to wake the daemon. Sets awaiting_human_input with reason 'release-approval-pending' and an awaiting_human_ref naming the PR, so the ticket enters the human's queue with the PR linked and its resolution produces the true→false flip the daemon wakes on. Never touches workflow_state — the ticket legitimately stays Built until the deploy succeeds. Idempotent: re-flagging rewrites the same triple. Use ONLY for the modeled release-approval pause; an ad-hoc worker question belongs in an elicitation round instead. B-1071: REFUSES (returns `{ refused: true, reason: 'active-brief', active_brief, task_id }`, does NOT throw and does NOT write) when the task still has an active brief — a verify send-back must ALWAYS resolve its own release brief via the finish-work backflow (revert Deployed→Built, fix, compose an ordinary release-decision-pending brief) before calling this tool; a refusal here means a genuinely stale brief is active and needs a worker-question, not a retry.",
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
      review_decision: {
        type: 'string',
        description:
          "B-745: the PR's current `gh pr view --json reviewDecision` value at flag time (e.g. 'APPROVED', 'CHANGES_REQUESTED'). Optional — pass it whenever it was already fetched; recorded verbatim on the ref, unconditionally, every call.",
      },
    },
    required: ['task_id', 'pr_url'],
  },
};
