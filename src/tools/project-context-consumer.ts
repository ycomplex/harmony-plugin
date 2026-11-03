import type { SupabaseClient } from '@supabase/supabase-js';
import { getTask } from './tasks.js';
import { resolveDeliverableMarker } from './decision-only.js';
import { readProjectContext, CONTEXT_CATEGORIES, type ProjectContext } from './project-context.js';
import { refreshProjectContextFile } from './project-context-file.js';
import { addComment, listComments } from './comments.js';

export interface CompletionInput {
  workflow_state: string;
  labels: (string | { name?: string })[];
  reason: string;
  provenance: string;
  completion?: { gate?: string; to_state?: string };
}
/** B-1384 owns marker meaning; no second label-to-gate table. */
export function isContextCompletingAccept(input: CompletionInput): boolean {
  const marker = resolveDeliverableMarker(input.labels);
  return input.workflow_state === 'Verified' && marker.intended_gate !== null &&
    ['human-in-session', 'human-in-browser'].includes(input.provenance) &&
    input.completion?.gate === marker.intended_gate && input.completion.to_state === 'Verified' &&
    input.reason === (marker.intended_gate === 'clarify' ? 'clarification-draft' : 'design-decision-draft');
}
export interface ContextCompletionPorts {
  read(): Promise<ProjectContext>;
  refresh(snapshot: ProjectContext): Promise<unknown>;
  reportOnce(marker: string, content: string): Promise<void>;
}
/** Filesystem failure cannot unwind a human's already completed database acceptance. */
export async function consumeContextCompletion(taskId: string, briefId: string, ports: ContextCompletionPorts) {
  let snapshot: ProjectContext | undefined;
  try {
    snapshot = await ports.read();
    const file = await ports.refresh(snapshot);
    return { status: 'refreshed' as const, file };
  } catch (error) {
    const sources = snapshot?.blocks.flatMap(block => block.source_ids).sort() ?? [];
    const marker = `PROJECT-CONTEXT-PENDING task_id=${taskId} brief_id=${briefId} sources=${sources.join(',') || 'unreadable'}`;
    await ports.reportOnce(marker, `${marker}\nProject context is pending; acceptance remains complete. Source entry ids: ${sources.join(', ') || 'unreadable — re-read the completing brief and linked Accepted sources'}. ${error instanceof Error ? error.message : String(error)}\nBootstrap regenerates CLAUDE.md before its first commit; start-work repairs it in the next ticket PR.`);
    return { status: 'pending' as const, source_ids: sources };
  }
}
/** CLI-only orchestration: invoked by the session consuming a real completing accept. */
export async function refreshAfterCompletingAccept(client: SupabaseClient, projectId: string, userId: string,
  taskId: string, root: string) {
  const task = await getTask(client, projectId, { task_id: taskId });
  const scaffold = task.labels?.some((label: { name?: string }) => label.name === 'inception-scaffold');
  const contextTitle = task.title.startsWith('Founding proposition — ') || CONTEXT_CATEGORIES.some(row => row[2] === task.title);
  if (!scaffold || !contextTitle) return { status: 'not-applicable' as const, reason: 'Not an inception context source ticket.' };
  const { data: events, error } = await client.from('activity_events').select('metadata')
    .eq('task_id', task.id).eq('event_type', 'brief_resolved').order('created_at', { ascending: false });
  if (error) throw error;
  for (const event of events ?? []) {
    const meta = event.metadata as Record<string, unknown> | null;
    if (meta?.command !== 'accept' || typeof meta.brief_id !== 'string') continue;
    const { data: brief, error: briefError } = await client.from('briefs').select('reason,doc')
      .eq('task_id', task.id).eq('id', meta.brief_id).single();
    if (briefError) throw briefError;
    if (!isContextCompletingAccept({ workflow_state: task.workflow_state!, labels: task.labels ?? [],
      reason: brief.reason, provenance: String(meta.provenance ?? ''), completion: brief.doc?.frame?.completion })) continue;
    return consumeContextCompletion(task.id, meta.brief_id, {
      read: () => readProjectContext(client, projectId),
      refresh: snapshot => refreshProjectContextFile(root, snapshot),
      reportOnce: async (marker, content) => {
        const comments = await listComments(client, projectId, { task_id: task.id });
        if (!comments.some(comment => comment.content.split('\n')[0] === marker)) {
          await addComment(client, projectId, userId, { task_id: task.id, content });
        }
      },
    });
  }
  return { status: 'not-applicable' as const, reason: 'No recorded human completing accept for the resolved deliverable gate.' };
}
