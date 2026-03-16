import type { SupabaseClient } from '@supabase/supabase-js';

export interface ManageTaskLabelsArgs {
  task_id: string;
  add?: string[];
  remove?: string[];
}

export const manageTaskLabelsTool = {
  name: 'manage_labels',
  description:
    'Add or remove labels on a task. Unlike update_task (which replaces all labels), this tool lets you add or remove specific labels without knowing the current set.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task UUID',
      },
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to add',
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to remove',
      },
    },
    required: ['task_id'],
  },
};

export async function manageTaskLabels(
  client: SupabaseClient,
  args: ManageTaskLabelsArgs,
): Promise<{ added: string[]; removed: string[] }> {
  const results: { added: string[]; removed: string[] } = {
    added: [],
    removed: [],
  };

  // Add labels
  if (args.add && args.add.length > 0) {
    const rows = args.add.map((labelId) => ({
      task_id: args.task_id,
      label_id: labelId,
    }));
    const { error } = await client.from('task_labels').insert(rows).select();
    if (error) throw error;
    results.added = args.add;
  }

  // Remove labels
  if (args.remove && args.remove.length > 0) {
    const { error } = await client
      .from('task_labels')
      .delete()
      .eq('task_id', args.task_id)
      .in('label_id', args.remove);
    if (error) throw error;
    results.removed = args.remove;
  }

  return results;
}
