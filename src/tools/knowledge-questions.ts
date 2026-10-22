import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConductionId, getLeg } from '../config/run-config.js';
import { guardKnowledgeWriteProvenance } from './provenance.js';
import { claimContent, claimFields, decodeClaim, editedClaimContent, encodeClaim } from './knowledge-claim.js';

export type QuestionState = 'open' | 'parked' | 'decided';
export interface QuestionMetadata {
  version: 1; state: QuestionState; scope: 'product' | 'deployment';
  source_key?: string; source_fingerprint?: string;
}

export function questionProjection(row: { madr?: unknown; superseded_by?: string | null } | null | undefined) {
  const q = (row?.madr as { question?: QuestionMetadata } | null)?.question;
  if (q?.version !== 1 || !['open', 'parked', 'decided'].includes(q.state)) return {};
  return { question_state: q.state, question_scope: q.scope,
    answer: q.state === 'decided' ? 'decided; see resulting decision' : 'not yet decided',
    resulting_decision_id: q.state === 'decided' ? row?.superseded_by ?? null : null };
}

/** Only a positively identified absent RPC enables the compatibility route. */
export function missingQuestionCapability(error: { code?: string; message?: string } | null) {
  return error?.code === 'PGRST202' || (error?.code === '42883' && /knowledge_question_(search|save|import)/.test(error.message ?? ''));
}

export interface SaveQuestionArgs {
  title?: string; content?: string; state: QuestionState; scope?: 'product' | 'deployment';
  question_id?: string; expected_updated_at?: string; resulting_decision_id?: string; reopen?: boolean;
  provenance?: string; domain?: string[]; claim?: string;
}

export async function saveKnowledgeQuestion(client: SupabaseClient, projectId: string, args: SaveQuestionArgs) {
  if (!['open', 'parked', 'decided'].includes(args.state)) throw new Error('state must be open, parked or decided');
  guardKnowledgeWriteProvenance(args.provenance);
  let content = args.content;
  if (!args.question_id) {
    content = claimContent(args.title ?? '', content ?? '', args.claim);
  } else if (content !== undefined || args.claim !== undefined) {
    const current = await client.from('knowledge_decisions').select('*')
      .eq('project_id', projectId).eq('id', args.question_id).single();
    if (current.error) throw new Error(current.error.message);
    content = editedClaimContent(current.data, { title: args.title, content, claim: args.claim });
  }
  const { data, error } = await client.rpc('knowledge_question_save', {
    p_project_id: projectId, p_title: args.title ?? null, p_content: content ?? null,
    p_state: args.state, p_scope: args.scope ?? null, p_question_id: args.question_id ?? null,
    p_expected_updated_at: args.expected_updated_at ?? null, p_decision_id: args.resulting_decision_id ?? null,
    p_domain: args.domain ?? null, p_reopen: args.reopen ?? false, p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null, p_leg: getLeg() ?? null,
  });
  if (missingQuestionCapability(error)) throw new Error('Question management unavailable: apply the B-1242 database capability. No question was saved.');
  if (error) throw new Error(error.message);
  await embedQuestion(client, projectId, data);
  return { ...data, ...claimFields(data), ...questionProjection(data) };
}

// The guarded write has committed. Best-effort embedding must not turn it into an
// apparent failed create; lexical retrieval remains available without the vector.
async function embedQuestion(client: SupabaseClient, projectId: string, data: { id: string; title: string; content: string }) {
  try {
    const embedded = await client.functions.invoke('embed-knowledge', { body: { text: `${data.title}\n${data.content}` }, timeout: 2000 });
    if (!embedded.error && Array.isArray(embedded.data?.embedding)) {
      await client.from('knowledge_decisions').update({ embedding: `[${embedded.data.embedding.join(',')}]` })
        .eq('project_id', projectId).eq('id', data.id);
    }
  } catch { /* Lexical retrieval remains available when embedding is unavailable. */ }
}

export interface QuestionManifest {
  version: 1; project_id: string; milestone_id: string; source_fingerprint: string;
  source_name: string; warnings: string[];
  entries: Array<{ key: string; title: string; content: string; source_excerpt: string;
    state: 'open' | 'parked'; scope: 'product' | 'deployment'; domain: string[]; approved: boolean }>;
}

export function milestoneQuestionPreview(projectId: string, milestone: { id: string; name: string; description: string | null }): QuestionManifest {
  const source = milestone.description ?? '';
  // Extract proposals, never decisions. Every proposal requires a human review before apply.
  const excerpts = source.split('\n').filter(line => /^\s*[-*]\s+\S/.test(line));
  const used = new Set<string>();
  return { version: 1, project_id: projectId, milestone_id: milestone.id, source_name: milestone.name,
    source_fingerprint: createHash('md5').update(source).digest('hex'),
    warnings: ['Historical milestone prose may include themes that have since been decided. Review every source excerpt against current knowledge; approve only unresolved themes. Nothing is written by preview.'],
    entries: excerpts.map(source_excerpt => {
      const text = source_excerpt.replace(/^\s*[-*]\s+/, '');
      const key = text.match(/^[A-Z][A-Z0-9]*-\d+\b/)?.[0]
        ?? createHash('sha256').update(text).digest('hex').slice(0, 24);
      if (used.has(key)) throw new Error(`Duplicate theme key ${key}; review the milestone before importing`);
      used.add(key);
      return { key, title: `Open question: ${text.slice(0, 160)}`,
        content: encodeClaim(`Not yet decided. Proposed from milestone “${milestone.name}”; this is not evidence of shipped behaviour.\n\n${source_excerpt}`,
          `Theme ${key} is proposed as an unresolved question, subject to review.`, 'derived'),
        source_excerpt, state: 'parked' as const, scope: 'product' as const, domain: ['product'], approved: false };
    }) };
}

export async function previewKnowledgeQuestions(client: SupabaseClient, projectId: string, args: { milestone_id: string }) {
  const { data, error } = await client.from('milestones').select('id, name, description')
    .eq('project_id', projectId).eq('id', args.milestone_id).single();
  if (error) throw new Error(error.message);
  return milestoneQuestionPreview(projectId, data);
}

export async function importKnowledgeQuestions(client: SupabaseClient, projectId: string,
  args: { manifest: QuestionManifest; provenance?: string }) {
  guardKnowledgeWriteProvenance(args.provenance);
  if (args.manifest.project_id !== projectId) throw new Error('Manifest belongs to another project');
  const manifest = { ...args.manifest, entries: args.manifest.entries.map(entry => ({ ...entry,
    content: decodeClaim(entry.content).claim ? entry.content : claimContent(entry.title, entry.content),
  })) };
  const { data, error } = await client.rpc('knowledge_question_import', { p_project_id: projectId,
    p_manifest: manifest, p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null, p_leg: getLeg() ?? null });
  if (missingQuestionCapability(error)) throw new Error('Question import unavailable: apply the B-1242 database capability. Nothing was imported.');
  if (error) throw new Error(error.message);
  for (const result of data.results ?? []) {
    if (result.outcome !== 'created') continue;
    const entry = manifest.entries.find(item => item.key === result.key);
    if (entry) await embedQuestion(client, projectId, { ...entry, id: result.id });
  }
  return data;
}

export const saveKnowledgeQuestionTool = {
  name: 'save_knowledge_question', description: 'Create an explicitly scoped unresolved knowledge question, or atomically change its state. Accepted acknowledges the question, not an answer or shipped behaviour. For changes supply question_id and expected_updated_at from a fresh read. Deciding requires an accepted resulting decision in this project; reopening a decided question requires reopen:true. Type remains advisory.',
  inputSchema: { type: 'object' as const, properties: {
    title: { type: 'string' }, content: { type: 'string' }, claim: { type: 'string', description: 'Optional authored one-sentence claim; omission uses the shared derived-proposal contract.' }, state: { type: 'string', enum: ['open', 'parked', 'decided'] },
    scope: { type: 'string', enum: ['product', 'deployment'] }, question_id: { type: 'string' },
    expected_updated_at: { type: 'string' }, resulting_decision_id: { type: 'string' }, reopen: { type: 'boolean' },
    domain: { type: 'array', items: { type: 'string' }, description: 'Subject domains; new questions default to product. Scope is separate.' },
    provenance: { type: 'string' },
  }, required: ['state'] },
};
export const previewKnowledgeQuestionsTool = {
  name: 'preview_knowledge_questions', description: 'Read-only preview of milestone bullet themes as question proposals. Source-attributed, fingerprinted manifest; each item starts approved:false. Review historical themes against current decisions before approving any. Generic across projects.',
  inputSchema: { type: 'object' as const, properties: { milestone_id: { type: 'string' } }, required: ['milestone_id'] },
};
export const importKnowledgeQuestionsTool = {
  name: 'import_knowledge_questions', description: 'Explicitly apply a reviewed milestone-question manifest. Only approved:true entries are imported. The database checks source freshness, project isolation and replay identity atomically; conflicts never overwrite existing questions. Does not decide themes or mark them shipped.',
  inputSchema: { type: 'object' as const, properties: { manifest: { type: 'object', additionalProperties: true }, provenance: { type: 'string' } }, required: ['manifest'] },
};
