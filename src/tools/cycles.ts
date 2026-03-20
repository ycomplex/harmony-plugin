import type { SupabaseClient } from '@supabase/supabase-js';

export const listCyclesTool = {
  name: 'list_cycles',
  description: 'List all cycles in the project, ordered by sequence number. Status is derived: completed (end < today), active (start <= today <= end), next (start > today).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', enum: ['active', 'next', 'completed'], description: 'Filter by derived status. Optional.' },
    },
  },
};

export async function listCycles(client: SupabaseClient, projectId: string, args: { status?: string }) {
  const { data, error } = await client
    .from('cycles')
    .select('*')
    .eq('project_id', projectId)
    .order('sequence_number');
  if (error) throw error;

  const today = new Date().toISOString().split('T')[0];
  const withStatus = data.map(c => ({
    ...c,
    derived_status: c.end_date < today ? 'completed' : c.start_date <= today ? 'active' : 'next',
  }));

  if (args.status) return withStatus.filter(c => c.derived_status === args.status);
  return withStatus;
}

export const createCycleTool = {
  name: 'create_cycle',
  description: 'Create the first cycle for a project. Errors if cycles already exist. Subsequent cycles are auto-created.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      name: { type: 'string', description: 'Cycle name. Defaults to "Cycle 1".' },
    },
    required: ['start_date'],
  },
};

export async function createCycle(
  client: SupabaseClient, projectId: string, userId: string,
  args: { start_date: string; name?: string }
) {
  // Verify no cycles exist
  const { data: existing } = await client
    .from('cycles')
    .select('id')
    .eq('project_id', projectId)
    .limit(1);
  if (existing && existing.length > 0) throw new Error('Cycles already exist for this project. Subsequent cycles are auto-created.');

  // Get project cycle_duration
  const { data: project } = await client
    .from('projects')
    .select('cycle_duration')
    .eq('id', projectId)
    .single();
  const duration = project?.cycle_duration ?? 14;

  const endDate = addDays(args.start_date, duration - 1);
  const { data, error } = await client
    .from('cycles')
    .insert({
      project_id: projectId,
      name: args.name ?? 'Cycle 1',
      sequence_number: 1,
      start_date: args.start_date,
      end_date: endDate,
      created_by: userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export const updateCycleTool = {
  name: 'update_cycle',
  description: "Update an active or next cycle's name or end_date. Changing the active cycle's end_date cascades to the next cycle's start_date.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      cycle_id: { type: 'string', description: 'Cycle ID' },
      name: { type: 'string', description: 'New name' },
      end_date: { type: 'string', description: 'New end date (YYYY-MM-DD)' },
    },
    required: ['cycle_id'],
  },
};

export async function updateCycle(
  client: SupabaseClient, projectId: string,
  args: { cycle_id: string; name?: string; end_date?: string }
) {
  const updates: Record<string, unknown> = {};
  if (args.name) updates.name = args.name;
  if (args.end_date) updates.end_date = args.end_date;

  const { data, error } = await client
    .from('cycles')
    .update(updates)
    .eq('id', args.cycle_id)
    .eq('project_id', projectId)
    .select()
    .single();
  if (error) throw error;

  // If end_date changed on active cycle, shift the entire next cycle (preserve its duration)
  if (args.end_date) {
    const today = new Date().toISOString().split('T')[0];
    if (data.start_date <= today && today <= data.end_date) {
      const nextSeq = data.sequence_number + 1;
      const { data: nextCycle } = await client
        .from('cycles')
        .select('id, start_date, end_date')
        .eq('project_id', projectId)
        .eq('sequence_number', nextSeq)
        .single();

      if (nextCycle) {
        const nextDurationMs = new Date(nextCycle.end_date + 'T00:00:00').getTime()
          - new Date(nextCycle.start_date + 'T00:00:00').getTime();
        const nextDurationDays = Math.round(nextDurationMs / 86400000);
        const newNextStart = addDays(args.end_date, 1);
        const newNextEnd = addDays(newNextStart, nextDurationDays);

        await client
          .from('cycles')
          .update({ start_date: newNextStart, end_date: newNextEnd })
          .eq('id', nextCycle.id);
      }
    }
  }

  return data;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
