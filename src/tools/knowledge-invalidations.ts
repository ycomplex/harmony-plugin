import type { SupabaseClient } from '@supabase/supabase-js';

export interface RemovalDeclaration { claim: string; invalidates: string[] }
export interface InvalidationLink {
  affected_id: string; invalidator_id: string; invalidator_title: string;
  claim: string; effective_at: string | null; rollout_state: string | null;
}
export interface InvalidationRead { available: boolean; rollout_available: boolean; links: InvalidationLink[] }

export function validateRemovals(doc: { removes?: unknown; removal_policy_only?: unknown; removal_effective_on_accept?: unknown }, reason?: string): asserts doc is { removes?: RemovalDeclaration[]; removal_policy_only?: boolean; removal_effective_on_accept?: boolean } {
  for (const field of ['removal_policy_only', 'removal_effective_on_accept'] as const) {
    if (doc[field] !== undefined && typeof doc[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  if (doc.removal_effective_on_accept === true && (doc.removal_policy_only !== true || !Array.isArray(doc.removes) || !doc.removes.length)) {
    throw new Error('effective-on-accept requires a policy-only removal declaration');
  }
  if (doc.removes === undefined) return;
  if (!Array.isArray(doc.removes)) throw new Error('removes must be an array');
  if (doc.removes.length && reason && reason !== 'design-decision-draft') throw new Error('removes requires a design decision');
  for (const removal of doc.removes) {
    if (!removal || typeof removal.claim !== 'string' || !removal.claim.trim()
        || !Array.isArray(removal.invalidates) || !removal.invalidates.length
        || !removal.invalidates.every((id: unknown) => typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
      throw new Error('each removal needs a claim and nonempty invalidates knowledge-entry UUIDs');
    }
  }
}

export async function readInvalidations(client: SupabaseClient, ids: string[]): Promise<InvalidationRead> {
  const { data, error } = await client.rpc('read_knowledge_invalidations', { p_entry_ids: ids });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      return { available: false, rollout_available: false, links: [] };
    }
    throw new Error(`Cannot read removal invalidations: ${error.message}`);
  }
  if (!data || data.available !== true || !Array.isArray(data.links)) {
    throw new Error('Invalid removal capability response');
  }
  return data as InvalidationRead;
}

export async function requireRemovalCapability(client: SupabaseClient, doc: { removes?: unknown }): Promise<void> {
  validateRemovals(doc);
  if (!doc.removes?.length) return;
  const capability = await readInvalidations(client, []);
  if (!capability.available) throw new Error('Removal enforcement capability unavailable: deploy the web migration before composing or accepting removals');
}

export async function withInvalidations<T extends { id: string }>(client: SupabaseClient, entries: T[]) {
  if (!entries.length) return entries;
  const read = await readInvalidations(client, entries.map(entry => entry.id));
  return entries.map(entry => ({ ...entry,
    invalidations_available: read.available,
    invalidation_rollout_available: read.rollout_available,
    invalidations: read.links.filter(link => link.affected_id === entry.id),
  }));
}

export function removalLines(doc: { removes?: RemovalDeclaration[]; removal_effective_on_accept?: boolean }): string[] {
  if (!doc.removes?.length) return [];
  return ['**Removals and affected knowledge:**', ...doc.removes.map(removal =>
    `- ${removal.claim} — invalidates: ${removal.invalidates.join(', ')}`),
  doc.removal_effective_on_accept
    ? 'Explicit policy cutover: this human acceptance marks the removal live and retires affected entries.'
    : 'Removal agreed, not yet effective until the invalidator rollout state is live.', ''];
}
