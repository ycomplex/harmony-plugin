// B-1073 (daemon-files-recording round) — the DAEMON files a fast-track ticket's post-merge recording
// itself, with no worker leg.
//
// THE PROBLEM THIS CLOSES. After the human accepts a fast-track conduction's release brief, the ball
// returns to the agent and `handleHeldConduction` (scheduler.ts) used to queue a WORKER whose only job
// was to run the conduct loop far enough to consume the accept remark, which files the
// `recorded_walk_requests` row the daemon's in-process drain then walks (Built -> Deployed -> verify
// brief). A whole worker leg to insert one row — B-1073's AC3 ("zero further worker legs") fails by
// construction. This module does that work in-process, under the daemon's lease.
//
// WHAT IT DOES, in order (every step FAIL-CLOSED: anything unconfirmable returns `handled: false` and the
// scheduler falls through to today's queue-a-worker path, byte-for-byte):
//   1. Positively confirm the ACCEPT from the activity timeline — the SAME evidence rule
//      `skills/finish-work/SKILL.md` O1 step 3 uses (B-734): a `brief_resolved` event with
//      `metadata.reason === 'release-decision-pending'` and `metadata.command === 'accept'` AFTER the
//      latest `workflow_state -> Built` field_change. The row shape alone (Built + flag down) is a TORN
//      pause too, and must never be read as an accept.
//   2. Idempotence: a `recorded_walk_requests` row already filed since that accept ⇒ nothing to file.
//      pending/processing ⇒ handled (the drain owns it); done/error ⇒ NOT handled (fall through; never
//      refile in a loop).
//   3. Confirm the recorded `field_values.build_pr` PR is MERGED, via the injected `getPrMergeState`
//      (NOT `deps.runCommand`). The recorded walk's deploy step advances Built -> Deployed WITHOUT checking
//      a merge happened, and a bot-authored PR still needs the human's GitHub approval+merge, which the
//      release accept alone does not perform. Not merged / unreadable ⇒ the worker path (finish-work)
//      handles approval/merge waiting.
//   4. File the row (summary = ticket title, evidence = build_pr, attestation = the accept remark verbatim
//      unless it says the walk was not done — `remarkAttestsWalk`), then consume the remark with
//      `skipRecordedWalkFiling` so `consumeAcceptRemark`'s own filing hook does not file a second row.
//
// Daemon code importing tools is fine; the reverse is the import cycle (see fasttrack-release-remark.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchPendingRemark, consumeAcceptRemark } from '../tools/briefs.js';
import {
  RELEASE_GATE_REASON,
  buildFastTrackReleaseRemarkRecordedWalkRequest,
  insertRecordedWalkRequest,
} from '../tools/fasttrack-release-remark.js';

export type PrMergeState = 'merged' | 'open' | 'closed' | 'unknown';

/** The board handle the daemon files through (the same client/project/user the drain uses). */
export interface FastTrackRecordingBoard {
  client: SupabaseClient;
  projectId: string;
  /** The daemon's own authenticated user id — recorded as the row's `requested_by`. */
  userId: string;
}

export interface FastTrackRecordingDeps {
  board: FastTrackRecordingBoard;
  getPrMergeState: (prUrl: string) => Promise<PrMergeState>;
  log: (line: string) => void;
}

export type FastTrackRecordingOutcome =
  | { handled: true; detail: string }
  | { handled: false; reason: string };

const REQUESTS_TABLE = 'recorded_walk_requests';

interface TimelineEntry {
  type?: string;
  timestamp?: string;
  event_type?: string;
  field_name?: string;
  new_value?: unknown;
  metadata?: { reason?: unknown; command?: unknown; brief_id?: unknown } | null;
}

/** The release accept for THIS release cycle, or null. Pure. Mirrors finish-work O1 step 3: the LAST
 *  `field_change` into `Built` (the start of this cycle — a re-opened ticket must not resume on its
 *  previous cycle's accept), then any LATER `brief_resolved` accept for the release brief. No `Built`
 *  entry at all ⇒ null (fail closed). The most recent matching accept wins. */
export function findReleaseAccept(
  timeline: TimelineEntry[],
): { timestamp: string; brief_id: string | null } | null {
  let builtAt = -1;
  timeline.forEach((e, i) => {
    if (e.type === 'event' && e.event_type === 'field_change' && e.field_name === 'workflow_state' && e.new_value === 'Built') {
      builtAt = i;
    }
  });
  if (builtAt < 0) return null;
  for (let i = timeline.length - 1; i > builtAt; i--) {
    const e = timeline[i];
    if (
      e.type === 'event' &&
      e.event_type === 'brief_resolved' &&
      e.metadata?.reason === RELEASE_GATE_REASON &&
      e.metadata?.command === 'accept'
    ) {
      return {
        timestamp: e.timestamp ?? '',
        brief_id: typeof e.metadata.brief_id === 'string' ? e.metadata.brief_id : null,
      };
    }
  }
  return null;
}

const declined = (reason: string): FastTrackRecordingOutcome => ({ handled: false, reason });

/** Try to file the post-merge recording for a fast-track conduction's accepted release. NEVER throws —
 *  any failure is `handled: false` (the scheduler then runs the ordinary worker path). The CALLER has
 *  already checked the cheap row-shape preconditions (conduction run_config.fast_track, workflow_state
 *  'Built', awaiting flag down); this function does the I/O-backed confirmation. */
export async function tryFileFastTrackPostMergeRecording(
  deps: FastTrackRecordingDeps,
  taskId: string,
): Promise<FastTrackRecordingOutcome> {
  const { client, projectId, userId } = deps.board;
  try {
    // 1. Positive evidence of the release accept.
    // The `activity_events` half of `list_activity` only (comments carry no `brief_resolved`), read
    // directly: `taskId` is already a resolved id, and the author join is not needed.
    const { data: events, error: eventsErr } = await client
      .from('activity_events')
      .select('event_type, field_name, new_value, metadata, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });
    if (eventsErr) return declined(`could not read the activity timeline (${eventsErr.message})`);
    const timeline: TimelineEntry[] = ((events ?? []) as Array<Record<string, unknown>>).map((e) => ({
      type: 'event',
      timestamp: e.created_at as string,
      event_type: e.event_type as string,
      field_name: e.field_name as string,
      new_value: e.new_value,
      metadata: e.metadata as TimelineEntry['metadata'],
    }));
    const accept = findReleaseAccept(timeline);
    if (!accept) return declined('release accept not positively evidenced after the latest advance into Built');

    // The release accept's remark, if any (only THIS accept's brief; any other unconsumed remark ⇒ ambiguous).
    const remark = await fetchPendingRemark(client, taskId);
    if (remark && (remark.reason !== RELEASE_GATE_REASON || (accept.brief_id !== null && remark.brief_id !== accept.brief_id))) {
      return declined(`an unconsumed remark on a different brief (${remark.reason}) is pending — ambiguous`);
    }
    const consumeRemark = async (): Promise<void> => {
      if (!remark) return;
      try {
        await consumeAcceptRemark(client, projectId, { brief_id: remark.brief_id }, userId, { skipRecordedWalkFiling: true });
      } catch (err) {
        deps.log(`fast-track recording: consuming the accept remark failed (${err instanceof Error ? err.message : String(err)}) — a later pass retries`);
      }
    };

    // 2. Idempotence — has a row been filed since this accept?
    const { data: existing, error: existingErr } = await client
      .from(REQUESTS_TABLE)
      .select('status, requested_at')
      .eq('task_id', taskId);
    if (existingErr) return declined(`could not read ${REQUESTS_TABLE} (${existingErr.message})`);
    const acceptMs = Date.parse(accept.timestamp);
    const sinceAccept = ((existing ?? []) as Array<{ status?: string; requested_at?: string }>).filter(
      (r) => Number.isNaN(acceptMs) || Date.parse(r.requested_at ?? '') > acceptMs,
    );
    if (sinceAccept.some((r) => r.status === 'pending' || r.status === 'processing')) {
      await consumeRemark();
      return { handled: true, detail: 'recording already filed — the drain owns it' };
    }
    if (sinceAccept.length > 0) return declined('a recording request was already processed for this accept — not refiling');

    // 3. The recorded PR must be MERGED.
    const { data: taskRow, error: taskErr } = await client
      .from('tasks')
      .select('title, field_values')
      .eq('id', taskId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (taskErr || !taskRow) return declined('could not read the ticket');
    const row = taskRow as { title?: string | null; field_values?: Record<string, unknown> | null };
    const prUrl = (row.field_values?.['build_pr'] as { pr_url?: unknown } | undefined)?.pr_url;
    if (typeof prUrl !== 'string' || !prUrl) return declined('no recorded build_pr.pr_url');
    const prState = await deps.getPrMergeState(prUrl);
    if (prState !== 'merged') return declined(`PR is not confirmed merged (${prState})`);

    // 4. File the row, then consume the remark (without the hook's own filing).
    const request = buildFastTrackReleaseRemarkRecordedWalkRequest({
      task_id: taskId,
      task_title: row.title ?? '',
      remark_detail: remark?.detail ?? null,
      build_pr_url: prUrl,
      requested_by: userId,
    });
    if (!(await insertRecordedWalkRequest(client, request))) return declined(`could not insert into ${REQUESTS_TABLE}`);
    await consumeRemark();
    return {
      handled: true,
      detail: `filed the post-merge recording (${request.attest_walk ? 'attested by the accept remark' : 'no attestation — human attests at verify'})`,
    };
  } catch (err) {
    return declined(`error (${err instanceof Error ? err.message : String(err)})`);
  }
}
