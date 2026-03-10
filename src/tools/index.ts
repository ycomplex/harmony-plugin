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
  ];
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  client: SupabaseClient,
  projectId: string,
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
        result = await createTask(client, projectId, args as any);
        break;
      case 'update_task':
        result = await updateTask(client, projectId, args as any);
        break;
      case 'bulk_create_tasks':
        result = await bulkCreateTasks(client, projectId, args as any);
        break;
      case 'create_epic':
        result = await createEpic(client, projectId, args as any);
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
