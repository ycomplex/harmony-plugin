import type { SupabaseClient } from '@supabase/supabase-js';
import { getProjectTool, getProject } from './project.js';
import { listEpicsTool, listEpics, createEpicTool, createEpic } from './epics.js';
import {
  listTasksTool, listTasks,
  getTaskTool, getTask,
  createTaskTool, createTask,
  updateTaskTool, updateTask,
  bulkCreateTasksTool, bulkCreateTasks,
} from './tasks.js';
import { listLabels, createLabel, listLabelsTool, createLabelTool } from './labels.js';
import { listSubtasksTool, listSubtasks, manageSubtasksTool, manageSubtasks } from './subtasks.js';
import { queryTasksTool, queryTasks } from './query-tasks.js';
import { listCommentsTool, listComments, addCommentTool, addComment } from './comments.js';

export function registerTools() {
  return [
    getProjectTool,
    listEpicsTool,
    listTasksTool,
    getTaskTool,
    createTaskTool,
    updateTaskTool,
    bulkCreateTasksTool,
    createEpicTool,
    listLabelsTool,
    createLabelTool,
    listSubtasksTool,
    manageSubtasksTool,
    queryTasksTool,
    listCommentsTool,
    addCommentTool,
  ];
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  client: SupabaseClient,
  projectId: string,
  userId: string,
) {
  try {
    let result: unknown;
    switch (name) {
      case 'get_project':
        result = await getProject(client, projectId);
        break;
      case 'list_epics':
        result = await listEpics(client, projectId);
        break;
      case 'list_tasks':
        result = await listTasks(client, projectId, args as any);
        break;
      case 'get_task':
        result = await getTask(client, projectId, args as any);
        break;
      case 'create_task':
        result = await createTask(client, projectId, userId, args as any);
        break;
      case 'update_task':
        result = await updateTask(client, projectId, args as any);
        break;
      case 'bulk_create_tasks':
        result = await bulkCreateTasks(client, projectId, userId, args as any);
        break;
      case 'create_epic':
        result = await createEpic(client, projectId, userId, args as any);
        break;
      case 'list_labels':
        result = await listLabels(client, projectId);
        break;
      case 'create_label':
        result = await createLabel(client, projectId, userId, args as any);
        break;
      case 'list_subtasks':
        result = await listSubtasks(client, projectId, args as any);
        break;
      case 'manage_subtasks':
        result = await manageSubtasks(client, projectId, userId, args as any);
        break;
      case 'query_tasks':
        result = await queryTasks(client, projectId, args as any);
        break;
      case 'list_comments':
        result = await listComments(client, args as any);
        break;
      case 'add_comment':
        result = await addComment(client, userId, args as any);
        break;
      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    const message = err.message ?? 'Unknown error';
    if (message.includes('permission denied') || message.includes('RLS')) {
      return { content: [{ type: 'text' as const, text: "You don't have access to this resource." }], isError: true };
    }
    if (message.includes('not found') || message.includes('no rows')) {
      return { content: [{ type: 'text' as const, text: `Not found: ${message}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
}
