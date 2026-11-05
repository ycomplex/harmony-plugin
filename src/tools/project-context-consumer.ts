import type { SupabaseClient } from '@supabase/supabase-js';
import { getTask } from './tasks.js';
import { readContextCompletions } from './project-context-completion.js';
import { readProjectContext, CONTEXT_CATEGORIES, type ProjectContext } from './project-context.js';
import { refreshProjectContextFile } from './project-context-file.js';
import { addComment, listComments } from './comments.js';

export { isContextCompletingAccept } from './project-context-completion.js';
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
  const completions = await readContextCompletions(client, projectId, {
    id: task.id, workflow_state: task.workflow_state!, labels: task.labels ?? [],
  });
  for (const completion of completions) {
    return consumeContextCompletion(task.id, completion.brief_id, {
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
