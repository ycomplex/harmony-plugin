import type { SupabaseClient } from '@supabase/supabase-js';
import { readKnowledgeNames } from './knowledge-names.js';
import { normalizeHtmlEntities } from './text-normalize.js';

export interface EntitySelector { entity_id?: string; name?: string; kind?: string }
export interface SelectedEntity { id: string; name: string; kind: string; project_id: string | null }

/** Thrown when a name (optionally narrowed by kind) matches more than one entity. Carries the candidates
 *  structurally so callers can ask the human which one was meant instead of parsing the message. */
export class AmbiguousEntitySelectionError extends Error {
  constructor(public readonly candidates: SelectedEntity[]) {
    super(`Ambiguous entity name; select entity_id or kind. Candidates: ${JSON.stringify(candidates)}`);
    this.name = 'AmbiguousEntitySelectionError';
  }
}

/** Exact selection only. Reads retain RLS and project scope, including on older schemas. */
export async function selectEntity(client: SupabaseClient, workspaceId: string, projectId: string, selector: EntitySelector): Promise<SelectedEntity | null> {
  const name = selector.name === undefined ? undefined : normalizeHtmlEntities(selector.name).trim();
  if (name === '' || selector.entity_id === '') throw new Error('Entity identity/name must not be blank');
  const names = await readKnowledgeNames(client, projectId, selector.entity_id ? { entity_ids: [selector.entity_id], search: name } : { search: name });
  let candidates: SelectedEntity[];
  if (names.available) {
    // An explicit retired id is deliberately refused: use its current survivor explicitly.
    candidates = names.matches.map(match => ({ id: match.concept_id, name: match.current_name, kind: match.kind ?? '', project_id: projectId }));
    if (selector.entity_id) candidates = candidates.filter(entity => entity.id === selector.entity_id);
    if (selector.entity_id && name !== undefined) {
      const byName = await readKnowledgeNames(client, projectId, { search: name });
      candidates = candidates.filter(entity => byName.matches.some(match => match.concept_id === entity.id));
    }
  } else {
    // The old table is still governed by RLS; never broaden on permission/network errors.
    let query = client.from('knowledge_entities').select('id, name, kind, project_id').eq('workspace_id', workspaceId)
      .or(`project_id.is.null,project_id.eq.${projectId}`);
    if (selector.entity_id) query = query.eq('id', selector.entity_id);
    if (selector.kind) query = query.eq('kind', selector.kind);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as SelectedEntity[];
    if (name !== undefined) candidates = candidates.filter(entity => entity.name.trim().toLowerCase() === name.toLowerCase());
  }
  if (selector.kind) candidates = candidates.filter(entity => entity.kind === selector.kind);
  candidates = [...new Map(candidates.map(entity => [entity.id, entity])).values()];
  if (candidates.length > 1) throw new AmbiguousEntitySelectionError(candidates);
  if (selector.entity_id && !candidates.length) throw new Error('Entity identity is unavailable in this project, retired, or conflicts with the supplied name/kind');
  return candidates[0] ?? null;
}
