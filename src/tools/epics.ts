import type { SupabaseClient } from '@supabase/supabase-js';

export const listEpicsTool = {
  name: 'list_epics',
  description: 'List all epics in the project',
  inputSchema: { type: 'object' as const, properties: {} },
};

export async function listEpics(client: SupabaseClient, projectId: string) {
  const { data, error } = await client
    .from('epics')
    .select('id, name, color, position')
    .eq('project_id', projectId)
    .order('position');
  if (error) throw error;
  return data;
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
