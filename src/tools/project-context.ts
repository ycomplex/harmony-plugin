import type { SupabaseClient } from '@supabase/supabase-js';
import { readContextAuthority, type ContextCompletion } from './project-context-completion.js';
import { claimFields } from './knowledge-claim.js';

export const CONTEXT_CATEGORIES = [
  ['architecture', 'Architecture', 'Decide the architecture'],
  ['repo', 'Repo & workspace topology', 'Decide the repo & workspace topology'],
  ['environments', 'Environment topology & deploy triggers', 'Decide the environment topology & deploy triggers'],
  ['data', 'Data & migration tooling', 'Decide the data & migration tooling'],
  ['ci', 'CI/CD', 'Decide the CI/CD approach'],
  ['testing', 'Testing', 'Decide the testing approach'],
  ['standards', 'Coding standards', 'Decide the coding standards'],
  ['identity', 'Authentication & identity', 'Decide the authentication & identity approach'],
  ['design', 'Design system', 'Decide the design system'],
] as const;
export interface ContextTask { id: string; title: string; task_number: number; workflow_state: string; labels?: { name?: string }[]; all_labels?: { labels: { name?: string } | { name?: string }[] }[]; task_labels?: { labels: { name?: string } | { name?: string }[] }[] }
export interface ContextSource {
  id: string; project_id: string | null; source_task_id: string | null; type: string;
  status: string; superseded_by: string | null; content: string; madr?: Record<string, unknown> | null;
  source_activity?: string | null; tags?: string[] | null; underwriting_brief_id?: string | null;
  claim?: string | null; claim_source?: string | null;
}
export interface ContextBlock {
  key: string; title: string; ticket: string | null; source_ids: string[];
  state: 'accepted' | 'undecided' | 'unresolved'; summary: string | null; diagnostics: string[];
}
export interface ProjectContext {
  applicability?: 'applicable' | 'not_applicable';
  version: 1; project_id: string; project_name: string; blocks: ContextBlock[]; diagnostics: string[];
}
const bounded = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
  value.length <= 1200 && value.trim().split(/\s+/).length <= 160 && !/[\r\n]|<!--/.test(value);

/** Only explicitly authored summaries or authored claims; never extract arbitrary rationale. */
export function sourceSummary(source: ContextSource, proposition: boolean): string | null {
  const structured = source.madr?.project_context;
  if (structured && typeof structured === 'object') {
    const fields = structured as Record<string, unknown>;
    if (proposition) {
      if (['purpose', 'personas', 'features'].every(key => bounded(fields[key]))) {
        return `Purpose: ${String(fields.purpose).trim()} Personas: ${String(fields.personas).trim()} Features: ${String(fields.features).trim()}`;
      }
      return null;
    }
    if (bounded(fields.summary)) return fields.summary.trim();
  }
  // These exact lines are authored in the brief's context and survive its ratified projection.
  const named = (name: string): string | null => {
    const matches = source.content.split('\n').filter(line => line.startsWith(`- Project context ${name}: `))
      .map(line => line.slice(`- Project context ${name}: `.length));
    return matches.length === 1 && bounded(matches[0]) ? matches[0].trim() : null;
  };
  if (proposition) {
    const purpose = named('purpose'), personas = named('personas'), features = named('features');
    if (purpose && personas && features) return `Purpose: ${purpose} Personas: ${personas} Features: ${features}`;
  } else {
    const summary = named('summary');
    if (summary) return summary;
  }
  const claim = claimFields(source);
  // A proposition claim alone does not establish all three founding dimensions.
  return !proposition && claim.claim_source === 'authored' && bounded(claim.claim) ? claim.claim.trim() : null;
}

/** Pure resolver: no timestamp tie-break and no unrelated semantic search. */
export function resolveContextBlock(projectId: string, key: string, title: string, tasks: ContextTask[],
  sources: ContextSource[], references: Map<string, string[]>, projectKey: string, completions: ContextCompletion[] = [], ruleIds: Set<string> = new Set(), lastDesignIds: string[] = []): ContextBlock {
  const block: ContextBlock = { key, title, ticket: null, source_ids: [], state: 'unresolved', summary: null, diagnostics: [] };
  if (tasks.length !== 1) {
    block.diagnostics.push(tasks.length ? 'Multiple matching scaffold tickets.' : 'Scaffold ticket not found.');
    return block;
  }
  const task = tasks[0]; block.ticket = `${projectKey}-${task.task_number}`;
  if (task.workflow_state !== 'Verified') { block.state = 'undecided'; return block; }
  const linked = new Set(references.get(task.id) ?? []);
  const authoritative = completions.length > 0;
  const completionIds = [...new Set(completions.flatMap(c => c.source_ids))];
  if (authoritative && (completionIds.length !== 1 || completions.some(c => c.source_ids.length !== 1))) {
    block.source_ids = completionIds.sort();
    block.diagnostics.push('Completing brief has missing or conflicting decision references.');
    return block;
  }
  const eligible = sources.filter(s => s.project_id === projectId &&
    (authoritative ? completionIds.includes(s.id) :
      (s.source_task_id === task.id || linked.has(s.id)) &&
      (key === 'proposition' ? s.type === 'specification' :
        s.source_activity === 'design-decide' &&
        !s.tags?.includes('rule') && !ruleIds.has(s.id))));
  if (authoritative && !eligible.length) {
    block.source_ids = completionIds;
    block.diagnostics.push(`Unreadable completing source ${completionIds[0]}.`);
    return block;
  }
  const byId = new Map(sources.filter(s => s.project_id === projectId).map(s => [s.id, s]));
  const current = new Map<string, ContextSource>();
  for (const initial of eligible) {
    let source = initial;
    const seen = new Set<string>();
    while (source.superseded_by) {
      if (seen.has(source.id)) { block.diagnostics.push(`Supersession cycle at ${source.id}.`); break; }
      seen.add(source.id);
      const successor = byId.get(source.superseded_by);
      if (!successor) { block.diagnostics.push(`Unreadable successor ${source.superseded_by} of ${source.id}.`); break; }
      source = successor;
    }
    if (!source.superseded_by && source.status === 'Accepted') current.set(source.id, source);
  }
  if (!authoritative && key !== 'proposition' && current.size > 1) {
    const named = [...current.keys()].filter(id => lastDesignIds.includes(id));
    if (named.length) for (const id of current.keys()) if (!named.includes(id)) current.delete(id);
  }
  block.source_ids = (current.size ? [...current.keys()] : eligible.map(source => source.id)).sort();
  if (block.diagnostics.length) return block;
  if (!current.size) {
    if (task.workflow_state === 'Verified') block.diagnostics.push('Completed ticket has no readable Accepted substantive source.');
    else block.state = 'undecided';
    return block;
  }
  // A product + technical pair may legitimately cover different tracks. Combining them would
  // silently choose authority; ask for one explicit context summary instead.
  if (current.size !== 1) { block.diagnostics.push('Competing Accepted sources; confirm the authoritative context source.'); return block; }
  const source = [...current.values()][0];
  const summary = sourceSummary(source, key === 'proposition');
  if (!summary) { block.diagnostics.push(`Source ${source.id} needs a bounded authored project_context summary${key === 'proposition' ? ' with purpose, personas and features' : ' or authored claim'}.`); return block; }
  block.state = 'accepted'; block.summary = summary;
  return block;
}

const PAGE = 500;
/** Read only; authenticated project scoping and RLS apply to every table. */
export async function readProjectContext(client: SupabaseClient, projectId: string): Promise<ProjectContext> {
  const { data: project, error } = await client.from('projects').select('id,name,key').eq('id', projectId).single();
  if (error) throw error;
  const tasks: ContextTask[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const result = await client.from('tasks').select('id,title,task_number,workflow_state,task_labels!inner(labels!inner(name)),all_labels:task_labels(labels(name))')
      .eq('project_id', projectId).eq('archived', false).is('subsumed_by_task_id', null)
      .eq('task_labels.labels.name', 'inception-scaffold').order('id').range(offset, offset + PAGE - 1);
    if (result.error) throw result.error;
    tasks.push(...(result.data ?? []));
    if ((result.data ?? []).length < PAGE) break;
  }
  if (!tasks.length) return { version: 1, project_id: projectId, project_name: project.name,
    applicability: 'not_applicable', blocks: [], diagnostics: [] };
  const authority = new Map<string, { completions: ContextCompletion[]; last_design_ids: string[] }>();
  for (const task of tasks) authority.set(task.id, await readContextAuthority(client, projectId, {
    ...task, labels: task.all_labels?.flatMap(row => row.labels) ?? task.labels ?? [],
  }));
  const sources: ContextSource[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const result = await client.from('knowledge_decisions').select('id,project_id,source_task_id,type,status,superseded_by,content,madr,source_activity,tags,underwriting_brief_id')
      .eq('project_id', projectId).order('id').range(offset, offset + PAGE - 1);
    if (result.error) throw result.error;
    sources.push(...(result.data ?? []));
    if ((result.data ?? []).length < PAGE) break;
  }
  const ruleIds = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const result = await client.from('decision_rule_citations').select('rule_entry_id')
      .eq('project_id', projectId).order('id').range(offset, offset + PAGE - 1);
    // Legacy projects can predate the citation relation. Other read failures stay visible.
    if (result.error) {
      if (['42P01', 'PGRST205'].includes(result.error.code)) break;
      throw result.error;
    }
    for (const row of result.data ?? []) ruleIds.add(row.rule_entry_id);
    if ((result.data ?? []).length < PAGE) break;
  }
  const references = new Map<string, string[]>();
  for (const task of tasks) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const result = await client.from('ticket_references_knowledge').select('decision_id').eq('task_id', task.id)
        .order('decision_id').range(offset, offset + PAGE - 1);
      if (result.error) throw result.error;
      ids.push(...(result.data ?? []).map(row => row.decision_id));
      if ((result.data ?? []).length < PAGE) break;
    }
    references.set(task.id, ids);
  }
  const definitions = [['proposition', 'What this project is', `Founding proposition — ${project.name}`], ...CONTEXT_CATEGORIES];
  const blocks = definitions.map(([key, title, ticketTitle]) => {
    const matching = tasks.filter(task => task.title === ticketTitle);
    return resolveContextBlock(projectId, key, title, matching, sources, references, project.key,
      matching.flatMap(task => authority.get(task.id)?.completions ?? []), ruleIds,
      matching.flatMap(task => authority.get(task.id)?.last_design_ids ?? []));
  });
  return { version: 1, applicability: 'applicable', project_id: projectId, project_name: project.name, blocks,
    diagnostics: blocks.flatMap(block => block.diagnostics.map(message => `${block.title}: ${message}`)) };
}
export const readProjectContextTool = {
  name: 'read_project_context',
  description: 'Read source-linked project CLAUDE.md context from project-local inception scaffold tickets and Accepted knowledge. Read-only; reports unresolved and undecided categories without inventing summaries.',
  inputSchema: { type: 'object' as const, properties: {} },
};
