import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const listCommentsTool = {
  name: 'list_comments',
  description: 'List all comments on a task, ordered by creation date (oldest first).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
    },
    required: ['task_id'],
  },
};

export async function listComments(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
) {
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client
    .from('task_comments')
    .select('id, content, user_id, created_at, updated_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export const addCommentTool = {
  name: 'add_comment',
  description: 'Add a comment to a task. Use for logging decisions, progress notes, or blockers.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
      content: {
        type: 'string',
        description: 'Comment content (markdown supported)',
      },
    },
    required: ['task_id', 'content'],
  },
};

export async function addComment(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { task_id: string; content: string },
) {
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client
    .from('task_comments')
    .insert({
      task_id: taskId,
      user_id: userId,
      content: args.content.replace(/\\n/g, '\n'),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
