// B-1047 — read the project's rule registry, so a design brief can name an amend/reference target
// (`target_entry_id`) and the fingerprint it expects (`expected_fingerprint`) instead of guessing one.
// Shared MCP + CLI core: the MCP tool `read_rule_registry` and `harmony knowledge rules` both call
// `readRuleRegistry`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingRelationOrFunction } from './acceptance-events.js';

export const RULE_REGISTRY_UNAVAILABLE = 'B-1047 rule registry not on this environment yet';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const readRuleRegistrySchema = z.object({
  entry_id: z.string().trim().min(1).optional(),
  domains: z.array(z.string().trim().min(1)).optional(),
  surfaces: z.array(z.string().trim().min(1)).optional(),
  search: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
}).strict();

export type ReadRuleRegistryArgs = z.infer<typeof readRuleRegistrySchema>;

/**
 * B-1421 — the rule fingerprint: sha256 hex of the UTF-8 bytes of `content`. Byte-for-byte the same as
 * the database's `b1047_rule_fingerprint(p) = encode(sha256(convert_to(p, 'UTF8')), 'hex')`, which the
 * B-1047 stale check hashes live against `knowledge_decisions.content`.
 */
export function ruleFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface RegistryRule {
  entry_id: string;
  /**
   * sha256 hex of the rule entry's CURRENT `content`, computed here (B-1421) — pass it as a design
   * rule's `expected_fingerprint`. Falls back to `stored_fingerprint` only when the content could not
   * be read (`drift: null`).
   */
  fingerprint: string;
  /** The registry row's stored `fingerprint` column, written only by a rule_bundle create/amend. */
  stored_fingerprint: string;
  /**
   * true: the stored registry row is stale (the entry's content was edited outside a rule_bundle);
   * `fingerprint` is still the right `expected_fingerprint`. false: in step. null: content unreadable.
   */
  drift: boolean | null;
  normalized_claim: string;
  scope: string;
  reach: 'this_surface' | 'this_product';
  domains: string[];
  surfaces: string[];
  title: string | null;
  status: string | null;
  content: string | null;
}

export type ReadRuleRegistryResult =
  | { availability: 'available'; rules: RegistryRule[] }
  | { availability: 'unavailable'; reason: string; rules: [] };

interface RegistryRow {
  entry_id: string; fingerprint: string; normalized_claim: string; scope: string;
  reach: 'this_surface' | 'this_product'; domains: string[] | null; surfaces: string[] | null;
}
interface EntryRow { id: string; title: string | null; status: string | null; content: string | null }

/** `%` and `_` are ilike wildcards: a search is a literal substring, never a pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function readRuleRegistry(
  client: SupabaseClient,
  projectId: string,
  args: unknown = {},
): Promise<ReadRuleRegistryResult> {
  const input = readRuleRegistrySchema.parse(args ?? {});
  let query = client
    .from('knowledge_rule_registry')
    .select('entry_id, fingerprint, normalized_claim, scope, reach, domains, surfaces')
    .eq('project_id', projectId);
  if (input.entry_id) query = query.eq('entry_id', input.entry_id);
  if (input.domains?.length) query = query.overlaps('domains', input.domains);
  if (input.surfaces?.length) query = query.overlaps('surfaces', input.surfaces);
  if (input.search) query = query.ilike('normalized_claim', `%${escapeLike(input.search)}%`);
  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(input.limit ?? DEFAULT_LIMIT);
  if (error) {
    // Only "this relation does not exist" degrades; permission and network errors stay errors.
    if (isMissingRelationOrFunction(error)) {
      return { availability: 'unavailable', reason: RULE_REGISTRY_UNAVAILABLE, rules: [] };
    }
    throw new Error(`read_rule_registry failed: ${error.message}`);
  }
  const rows = (data ?? []) as RegistryRow[];
  if (rows.length === 0) return { availability: 'available', rules: [] };

  const ids = [...new Set(rows.map((r) => r.entry_id))];
  const { data: entries, error: entryErr } = await client
    .from('knowledge_decisions')
    .select('id, title, status, content')
    .in('id', ids);
  if (entryErr) throw new Error(`read_rule_registry failed reading rule entries: ${entryErr.message}`);
  const byId = new Map(((entries ?? []) as EntryRow[]).map((e) => [e.id, e]));

  return {
    availability: 'available',
    rules: rows.map((r) => {
      const entry = byId.get(r.entry_id);
      const content = entry?.content;
      const live = typeof content === 'string' ? ruleFingerprint(content) : null;
      return {
        entry_id: r.entry_id,
        fingerprint: live ?? r.fingerprint,
        stored_fingerprint: r.fingerprint,
        drift: live === null ? null : live !== r.fingerprint,
        normalized_claim: r.normalized_claim,
        scope: r.scope,
        reach: r.reach,
        domains: r.domains ?? [],
        surfaces: r.surfaces ?? [],
        title: entry?.title ?? null,
        status: entry?.status ?? null,
        content: entry?.content ?? null,
      };
    }),
  };
}

export const readRuleRegistryTool = {
  name: 'read_rule_registry',
  description:
    "B-1047 — read the active project's rule registry. Each rule returns { entry_id, fingerprint, stored_fingerprint, drift, normalized_claim, scope, reach, domains, surfaces, title, status, content }. fingerprint is computed from the entry's current content (sha256 hex of its UTF-8 bytes); stored_fingerprint is the registry row's stored column; drift is true when they differ, false when equal, null when the content could not be read (then fingerprint falls back to stored_fingerprint). drift: true means the registry row is stale (the entry was edited outside a rule_bundle) — the live fingerprint is still the right expected_fingerprint. A design brief's amend/reference rule names target_entry_id = entry_id and expected_fingerprint = fingerprint; an amend quotes content as `before`. Filters: entry_id (exact), domains / surfaces (overlap — any listed value matches), search (case-insensitive substring of normalized_claim), limit (default 50, max 200). Returns { availability: 'available', rules } or, when this environment has no registry yet, { availability: 'unavailable', reason, rules: [] } — then amend/reference cannot be declared; never guess a fingerprint. Permission and network errors stay errors.",
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: { type: 'string', description: 'The rule knowledge entry id (exact match)' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Match rules whose domains overlap these' },
      surfaces: { type: 'array', items: { type: 'string' }, description: 'Match rules whose surfaces overlap these' },
      search: { type: 'string', description: 'Case-insensitive substring of normalized_claim' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    },
    additionalProperties: false,
  },
};
