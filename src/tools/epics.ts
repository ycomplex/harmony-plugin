import { sortEpics } from './epic-order.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const listEpicsTool = {
  name: 'list_epics',
  description: 'List all epics in the project',
  inputSchema: { type: 'object' as const, properties: {} },
};

/** Only an explicitly missing epics.retired_at may use the pre-migration projection. */
export function isMissingEpicRetirement(error: { code?: string; message?: string; details?: string } | null): boolean {
  if (!error || !['42703', 'PGRST204'].includes(error.code ?? '')) return false;
  const diagnostic = `${error.message ?? ''} ${error.details ?? ''}`;
  return /\bepics\b/.test(diagnostic) && /\bretired_at\b/.test(diagnostic)
    && /does not exist|could not find|not found|missing/i.test(diagnostic);
}

export async function listEpics(client: SupabaseClient, projectId: string) {
  const result = await client.from('epics').select('id, name, color, position, retired_at').eq('project_id', projectId);
  if (isMissingEpicRetirement(result.error)) {
    const legacy = await client.from('epics').select('id, name, color, position').eq('project_id', projectId);
    if (legacy.error) throw legacy.error;
    return sortEpics((legacy.data ?? []).map(epic => ({ ...epic, retired_at: null })));
  }
  if (result.error) throw result.error;
  return sortEpics((result.data ?? []).map(epic => ({ ...epic, retired_at: epic.retired_at ?? null })));
}

export async function assertActiveEpic(client: SupabaseClient, projectId: string, epicId: string | null | undefined) {
  if (!epicId) return;
  const epic = (await listEpics(client, projectId)).find(e => e.id === epicId);
  if (!epic) throw new Error('Epic is not available in this project');
  if (epic.retired_at) throw new Error(`Epic "${epic.name}" is retired; choose an active epic`);
}

export const createEpicTool = {
  name: 'create_epic',
  description: 'Create a new epic in the project',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Epic name' },
      color: { type: 'string', description: 'Hex color (e.g. #6366f1). Optional.' },
    },
    required: ['name'],
  },
};

export const updateEpicTool = {
  name: 'update_epic',
  description: "Update an epic's name or color",
  inputSchema: {
    type: 'object' as const,
    properties: {
      epic_id: { type: 'string', description: 'Epic ID' },
      name: { type: 'string', description: 'New name' },
      color: { type: 'string', description: 'New hex color (e.g. #6366f1)' },
    },
    required: ['epic_id'],
  },
};

export async function updateEpic(
  client: SupabaseClient,
  projectId: string,
  args: { epic_id: string; name?: string; color?: string }
) {
  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.color !== undefined) updates.color = args.color;

  const { data, error } = await client
    .from('epics')
    .update(updates)
    .eq('id', args.epic_id)
    .eq('project_id', projectId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createEpic(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { name: string; color?: string }
) {
  // Get next position
  const { data: existing } = await client
    .from('epics')
    .select('position')
    .eq('project_id', projectId)
    .order('position', { ascending: false })
    .limit(1);
  const nextPosition = (existing?.[0]?.position ?? -1) + 1;

  const { data, error } = await client
    .from('epics')
    .insert({
      project_id: projectId,
      name: args.name,
      color: args.color ?? '#6366f1',
      position: nextPosition,
      created_by: userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
