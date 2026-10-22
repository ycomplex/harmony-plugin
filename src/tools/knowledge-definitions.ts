import { guardKnowledgeWriteProvenance } from './provenance.js';
import { getConductionId, getLeg } from '../config/run-config.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Definition {
 id: string; concept_id: string; project_id: string; workspace_id: string;
 supersedes?: string[]; superseded_by?: string | null;
 kind: 'definition'; type: 'definition'; title: string; content: string; status: 'Accepted';
 domain: string[]; tags: string[]; updated_at: string; current_revision: string;
 source_decision_id: string; source_title: string; metadata: Record<string, unknown>;
 history: Array<{ id: string; content: string; source_decision_id: string; source_title: string; created_at: string }>;
 refinements: Array<{ id: string; title: string }>;
}
export interface DefinitionRead { available: boolean; definitions: Definition[]; total_count?: number }
export async function readDefinitions(client: SupabaseClient, workspaceId: string, projectId: string,
 args: { search?: string; domain?: string[]; limit?: number; offset?: number } = {}): Promise<DefinitionRead> {
 const definitions: Definition[] = [];
 const requested = args.limit ?? 50;
 if (!Number.isInteger(requested) || requested < 1 || !Number.isInteger(args.offset ?? 0) || (args.offset ?? 0) < 0) throw new Error('Invalid definition page');
 let total_count: number | undefined;
 for (;;) {
  const pageSize = Math.min(500, requested - definitions.length);
  const { data, error } = await client.rpc('read_knowledge_definitions', {
   p_workspace_id: workspaceId, p_project_id: projectId, p_search: args.search?.trim() || null,
   p_domain: args.domain?.length ? args.domain : null, p_limit: pageSize, p_offset: (args.offset ?? 0) + definitions.length,
  });
  if (error) {
   if ((error.code === 'PGRST202' || error.code === '42883') && error.message.includes('read_knowledge_definitions')) return { available: false, definitions: [] };
   throw new Error(`Cannot read definitions: ${error.message}`);
  }
  if (!data || data.available !== true || !Array.isArray(data.definitions)) throw new Error('Invalid definition capability response');
  definitions.push(...data.definitions); total_count = data.total_count;
  if (data.definitions.length < pageSize || definitions.length >= requested) return { available: true, definitions, total_count };
 }

}
export interface PublishDefinitionArgs {
 concept_id: string; expected_revision: string | null; source_decision_id: string;
 wording: string; provenance?: string; metadata?: Record<string, unknown>; refinement_ids?: string[];
}
export async function publishDefinition(client: SupabaseClient, projectId: string, args: PublishDefinitionArgs) {
 guardKnowledgeWriteProvenance(args.provenance);
 if (!args.wording?.trim()) throw new Error('Definition wording is required');
 if (args.expected_revision === undefined) throw new Error('Provide expected_revision (null for a new definition)');
 const { data, error } = await client.rpc('publish_knowledge_definition', {
  p_project_id: projectId, p_concept_id: args.concept_id, p_expected_revision: args.expected_revision,
  p_source_decision_id: args.source_decision_id, p_wording: args.wording.trim(),
  p_metadata: args.metadata ?? {}, p_refinement_ids: args.refinement_ids ?? [],
  p_provenance: args.provenance ?? null, p_conduction_id: getConductionId() ?? null, p_leg: getLeg() ?? null,
 });
 if (error) throw new Error(`Cannot publish definition: ${error.message}`);
 return data;
}
export const publishDefinitionTool = {
 name: 'publish_definition', description: 'Explicitly publish changed term wording from an Accepted project decision. Reuses a concept UUID; expected_revision provides compare-and-swap protection (null on first publication). Retains immutable history and refinement links. Unrelated decision acceptance never publishes automatically.',
 inputSchema: { type: 'object' as const, properties: {
  concept_id: { type: 'string', description: 'Existing concept entity UUID in this workspace' },
  expected_revision: { type: ['string', 'null'], description: 'Current revision UUID; null only for first publication' },
  source_decision_id: { type: 'string', description: 'Accepted decision explicitly authorizing this definition change in the current project' },
  wording: { type: 'string', description: 'Full quotable current wording; no ticket prefixes' },
  provenance: { type: 'string', description: 'Knowledge-write provenance; agent-on-behalf:<human provenance> when executing an accepted definition change' },
  metadata: { type: 'object', description: 'Source ticket, PR and commit references' },
  refinement_ids: { type: 'array', items: { type: 'string' }, description: 'Project decision UUIDs to link; existing links survive updates' },
 }, required: ['concept_id','expected_revision','source_decision_id','wording'] },
};
