import type { SupabaseClient } from '@supabase/supabase-js';
import type { BriefDoc } from './briefs.js';
import { getWorkspaceId } from './knowledge.js';

/** Advisory structural clue, never a claim that a build must have settled new behaviour.
 * Exact surface:<repo-relative-path> tags are the existing current-state identity. No fuzzy
 * search, new schema, or caller-authored match list; a failed lookup must not refuse compose. */
export async function settlementWarning(
  client: SupabaseClient, projectId: string, doc: BriefDoc, changedPaths?: string[],
): Promise<string | undefined> {
  if (doc.frame?.kind !== 'release' || doc.frame.settled_beyond_design?.length !== 0) return;
  const tags = [...new Set((changedPaths ?? []).filter(Boolean).map(path => `surface:${path.replace(/^\.\//, '')}`))];
  if (!tags.length) return;
  try {
    const workspaceId = await getWorkspaceId(client, projectId);
    const { data, error } = await client.from('knowledge_decisions')
      .select('id, title, tags').eq('workspace_id', workspaceId).eq('project_id', projectId)
      .eq('status', 'Accepted').overlaps('tags', tags).limit(20);
    if (error) throw error;
    if (!data?.length) return;
    return `settled_beyond_design is empty, but this diff touches surfaces with Accepted current-state entries: ${data.map(row => `${row.title} (${row.id})`).join('; ')}. Confirm no additional behaviour was settled, or record it before release. Advisory only.`;
  } catch {
    return 'Could not check settled_beyond_design against current-state surface entries; review the empty report manually. Advisory only.';
  }
}
