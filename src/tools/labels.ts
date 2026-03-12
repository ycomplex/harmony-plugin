import type { SupabaseClient } from '@supabase/supabase-js';

async function getWorkspaceIdForProject(client: SupabaseClient, projectId: string): Promise<string> {
  const { data, error } = await client
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();
  if (error) throw error;
  return data.workspace_id;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export const listLabelsTool = {
  name: 'list_labels',
  description: 'List all labels in the workspace',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export async function listLabels(client: SupabaseClient, projectId: string): Promise<Label[]> {
  const workspaceId = await getWorkspaceIdForProject(client, projectId);
  const { data, error } = await client
    .from('labels')
    .select('id, name, color')
    .eq('workspace_id', workspaceId)
    .order('name');
  if (error) throw error;
  return data as Label[];
}

export const createLabelTool = {
  name: 'create_label',
  description: 'Create a new label in the workspace',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Label name' },
      color: { type: 'string', description: 'Color key (red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, pink). Defaults to blue.' },
    },
    required: ['name'],
  },
};

export async function createLabel(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { name: string; color?: string }
): Promise<Label> {
  const workspaceId = await getWorkspaceIdForProject(client, projectId);
  const { data, error } = await client
    .from('labels')
    .insert({
      workspace_id: workspaceId,
      name: args.name,
      color: args.color ?? 'blue',
      created_by: userId,
    })
    .select('id, name, color')
    .single();
  if (error) throw error;
  return data as Label;
}
