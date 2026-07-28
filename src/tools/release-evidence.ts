// B-734 Phase B: the release-evidence pause — sibling of the B-732 release-approval pause.
//
// finish-work's O1 release resume check no longer infers "a human accepted the release" from the
// ABSENCE of an active brief. B-734 gave the ticket history a POSITIVE record — a `brief_resolved`
// decision entry written by resolve_brief — so the check now requires that evidence before an
// irreversible merge. Absence of provenance is absence of evidence, not evidence of a human.
//
// That check therefore FAILS CLOSED, and a fail-closed check needs somewhere to fail TO. Simply
// stopping would be a SILENT STALL: B-697 showed a worker's prose-to-stdout is discarded by the
// daemon, so an explanation the worker prints reaches nobody, the ticket sits at Built with
// awaiting_human_input false — in nobody's queue — and nothing ever wakes the daemon to retry. This
// tool closes both ends at once: it puts the ticket in the human's queue WITH the reason stated and
// the release brief named, and its resolution produces the true → false flag flip the daemon already
// wakes on.
//
// WHY A DEDICATED TOOL rather than update_task: the awaiting_* flag triple is a human-pause
// assertion, and every writer of it is the tool whose semantics justify it (compose_brief owns the
// brief pause, file_elicitation_round owns the question pause, flag_release_approval_pending owns the
// GitHub-approval pause). Exposing the triple on the general update_task would let any caller forge a
// pause with no corresponding artefact behind it. This is the missing-release-evidence pause's owner,
// and it writes NOTHING else — in particular it never touches workflow_state, because the ticket
// legitimately stays at Built: the release did not happen, so nothing advanced.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const RELEASE_EVIDENCE_REASON = 'release-evidence-missing';

export interface FlagReleaseEvidenceMissingArgs {
  task_id: string;
  brief_id?: string;
  task_visual_id?: string;
}

export interface ReleaseEvidenceRef {
  kind: 'release-evidence';
  brief_id?: string;
  task_visual_id?: string;
}

export interface FlagReleaseEvidenceMissingResult {
  task_id: string;
  awaiting_human_input: true;
  awaiting_human_reason: string;
  awaiting_human_ref: ReleaseEvidenceRef;
}

export async function flagReleaseEvidenceMissing(
  client: SupabaseClient,
  projectId: string,
  args: FlagReleaseEvidenceMissingArgs,
): Promise<FlagReleaseEvidenceMissingResult> {
  if (!args.task_id) throw new Error('task_id is required');

  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // Optional keys are OMITTED rather than emitted as null (mirrors release-approval's ref style):
  // the ref is read as "what identifies this pause", and a null key reads as a recorded absence.
  const ref: ReleaseEvidenceRef = {
    kind: 'release-evidence',
    ...(args.brief_id === undefined ? {} : { brief_id: args.brief_id }),
    ...(args.task_visual_id === undefined ? {} : { task_visual_id: args.task_visual_id }),
  };

  // Idempotent by construction: re-flagging an already-flagged pause rewrites the same triple.
  // A worker that retries the release leg and hits the same missing evidence must not error here.
  const { error } = await client
    .from('tasks')
    .update({
      awaiting_human_input: true,
      awaiting_human_reason: RELEASE_EVIDENCE_REASON,
      awaiting_human_ref: ref,
    })
    .eq('id', taskId);
  if (error) throw new Error(error.message);

  return {
    task_id: taskId,
    awaiting_human_input: true,
    awaiting_human_reason: RELEASE_EVIDENCE_REASON,
    awaiting_human_ref: ref,
  };
}

export const flagReleaseEvidenceMissingTool = {
  name: 'flag_release_evidence_missing',
  description:
    "B-734: pause a release leg because the ticket carries NO recorded evidence that a human accepted the release. finish-work's O1 resume check requires a positive `brief_resolved` decision entry (B-734 gave ticket history that record) before an irreversible merge — it no longer infers acceptance from a missing brief — so it fails CLOSED when the entry is absent. Stopping silently would strand the ticket: a worker's prose to stdout is discarded by the daemon (B-697), the ticket would sit at Built with awaiting_human_input false — in nobody's queue — and nothing would wake the daemon. Sets awaiting_human_input with reason 'release-evidence-missing' and an awaiting_human_ref naming the release brief whose decision entry is absent, so the ticket enters the human's queue with the reason stated and its resolution produces the true→false flip the daemon wakes on. Never touches workflow_state — the ticket legitimately stays Built, because the release did not happen. Idempotent: re-flagging rewrites the same triple. Use ONLY for this modeled missing-evidence pause; a bot-authored PR awaiting GitHub approval is flag_release_approval_pending, and an ad-hoc worker question belongs in an elicitation round.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
      brief_id: {
        type: 'string',
        description:
          'The release brief (UUID) whose decision entry is absent — what the human is being asked to account for.',
      },
      task_visual_id: {
        type: 'string',
        description: "The ticket's visual ID (e.g., B-734), for a queue entry that reads without a lookup.",
      },
    },
    required: ['task_id'],
  },
};
