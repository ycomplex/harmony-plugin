import type { SupabaseClient } from '@supabase/supabase-js';
import { getTask, updateTask } from './tasks.js';
import { addComment, listComments } from './comments.js';
import { normalizeHtmlEntities } from './text-normalize.js';
import { liveWaitingOn, parseWaitingOn, recoverCommentWait, waitingOnFieldValues, WAITING_ON_KINDS, type WaitingOn, type WaitingOnKind } from '../daemon/waiting-on.js';

export interface DeclareWaitArgs { task_id: string; kind: WaitingOnKind; ref: string; resume_after?: string }
export async function declareWait(client: SupabaseClient, projectId: string, userId: string, args: DeclareWaitArgs) {
  if (!WAITING_ON_KINDS.includes(args.kind)) throw new Error('Invalid wait kind');
  // A ref is a single marker token, not an arbitrary comment body.
  if (typeof args.ref !== 'string' || (!/^\S+$/.test(args.ref) || args.ref.includes('\\') || normalizeHtmlEntities(args.ref) !== args.ref)) throw new Error('Wait ref must be a nonblank single token');
  if (args.resume_after !== undefined && !Number.isFinite(Date.parse(args.resume_after))) throw new Error('Invalid resume_after');
  const task = await getTask(client, projectId, { task_id: args.task_id, view: 'meta' });
  const prior = parseWaitingOn(waitingOnFieldValues(task));
  const now = new Date().toISOString();
  const marker: WaitingOn = {
    kind: args.kind, ref: args.ref, since: now,
    first_since: prior?.kind === args.kind && prior.ref === args.ref ? prior.first_since : now,
    ...(args.resume_after === undefined ? {} : { resume_after: args.resume_after }),
  };
  await updateTask(client, projectId, { task_id: task.id, field_values: { waiting_on: marker } });
  try {
    await addComment(client, projectId, userId, { task_id: task.id, content: `WAITING-ON ref=${args.ref}` });
  } catch (err) {
    throw new Error(`Wait marker saved but WAITING-ON comment failed; retry the declaration: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return { declared: true, waiting_on: marker };
}

/** Persist before acknowledging a recovered hold, so restart and the existing hold gate see it. */
export async function recoverDeclaredWait(client: SupabaseClient, projectId: string, taskId: string, firedAtMs: number, nowMs: number): Promise<WaitingOn | null> {
  if (!Number.isFinite(firedAtMs)) return null;
  const task = await getTask(client, projectId, { task_id: taskId, view: 'meta' });
  if (task.awaiting_human_input || task.pending_acceptance_event_id || task.stale || ['Verified', 'Cancelled', 'Parked'].includes(task.workflow_state ?? '')) return null;
  const fields = waitingOnFieldValues(task);
  if (liveWaitingOn(fields, { firedAtMs, nowMs })) return null;
  const comments = await listComments(client, projectId, { task_id: task.id });
  const marker = recoverCommentWait(comments ?? [], fields, { firedAtMs, nowMs });
  if (!marker) return null;
  await updateTask(client, projectId, { task_id: task.id, field_values: { waiting_on: marker } });
  return marker;
}
