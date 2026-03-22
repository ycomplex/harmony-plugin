import type { SupabaseClient } from '@supabase/supabase-js';

export const listMembersTool = {
  name: 'list_members',
  description: 'List all members of the workspace. Returns user IDs, display names, emails, and roles. Use this to look up assignee IDs for task assignment.',
  inputSchema: { type: 'object' as const, properties: {} },
};

export async function listMembers(client: SupabaseClient, projectId: string) {
  // Get workspace ID from project
  const { data: project, error: projError } = await client
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();
  if (projError) throw projError;

  const { data, error } = await client
    .from('workspace_members')
    .select('user_id, role, joined_at, profile:profiles!workspace_members_user_id_profiles_fkey(display_name, email)')
    .eq('workspace_id', project.workspace_id)
    .order('joined_at', { ascending: true });
  if (error) throw error;

  return (data as any[]).map(m => ({
    user_id: m.user_id,
    display_name: m.profile?.display_name ?? null,
    email: m.profile?.email ?? null,
    role: m.role,
  }));
}

/**
 * Resolve an assignee string to a user_id UUID.
 * Accepts: UUID, display name (partial match), or email (exact match).
 * Throws if no match or multiple matches found.
 */
export async function resolveAssignee(
  client: SupabaseClient,
  projectId: string,
  assignee: string,
): Promise<string> {
  // If it looks like a UUID, return it directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignee)) {
    return assignee;
  }

  const members = await listMembers(client, projectId);
  const query = assignee.toLowerCase();

  // Try exact email match first
  const emailMatch = members.filter(m => m.email?.toLowerCase() === query);
  if (emailMatch.length === 1) return emailMatch[0].user_id;

  // Try display name match (case-insensitive, partial)
  const nameMatch = members.filter(m =>
    m.display_name?.toLowerCase().includes(query)
  );
  if (nameMatch.length === 1) return nameMatch[0].user_id;
  if (nameMatch.length > 1) {
    const names = nameMatch.map(m => m.display_name ?? m.email).join(', ');
    throw new Error(`Ambiguous assignee "${assignee}" — matches multiple members: ${names}. Be more specific.`);
  }

  throw new Error(`No member found matching "${assignee}". Use list_members to see available members.`);
}
