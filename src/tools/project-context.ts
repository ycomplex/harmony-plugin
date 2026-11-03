import type { SupabaseClient } from '@supabase/supabase-js';
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
export interface ContextTask { id: string; title: string; task_number: number; workflow_state: string }
export interface ContextSource {
  id: string; project_id: string | null; source_task_id: string | null; type: string;
  status: string; superseded_by: string | null; content: string; madr?: Record<string, unknown> | null;
  claim?: string | null; claim_source?: string | null;
}
export interface ContextBlock {
  key: string; title: string; ticket: string | null; source_ids: string[];
  state: 'accepted' | 'undecided' | 'unresolved'; summary: string | null; diagnostics: string[];
}
export interface ProjectContext {
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
  sources: ContextSource[], references: Map<string, string[]>, projectKey: string): ContextBlock {
  const block: ContextBlock = { key, title, ticket: null, source_ids: [], state: 'unresolved', summary: null, diagnostics: [] };
  if (tasks.length !== 1) {
    block.diagnostics.push(tasks.length ? 'Multiple matching scaffold tickets.' : 'Scaffold ticket not found.');
    return block;
  }
  const task = tasks[0]; block.ticket = `${projectKey}-${task.task_number}`;
  if (task.workflow_state !== 'Verified') { block.state = 'undecided'; return block; }
  const linked = new Set(references.get(task.id) ?? []);
  const eligible = sources.filter(s => s.project_id === projectId && (s.source_task_id === task.id || linked.has(s.id)) &&
    (key === 'proposition' ? s.type === 'specification' : ['architecture', 'business', 'convention', 'product-design', 'technical-design', 'ux-ui-design'].includes(s.type)));
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
    const result = await client.from('tasks').select('id,title,task_number,workflow_state,task_labels!inner(labels!inner(name))')
      .eq('project_id', projectId).eq('archived', false).is('subsumed_by_task_id', null)
      .eq('task_labels.labels.name', 'inception-scaffold').order('id').range(offset, offset + PAGE - 1);
    if (result.error) throw result.error;
    tasks.push(...(result.data ?? []));
    if ((result.data ?? []).length < PAGE) break;
  }
  const sources: ContextSource[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const result = await client.from('knowledge_decisions').select('id,project_id,source_task_id,type,status,superseded_by,content,madr')
      .eq('project_id', projectId).order('id').range(offset, offset + PAGE - 1);
    if (result.error) throw result.error;
    sources.push(...(result.data ?? []));
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
  const blocks = definitions.map(([key, title, ticketTitle]) => resolveContextBlock(projectId, key, title,
    tasks.filter(task => task.title === ticketTitle), sources, references, project.key));
  return { version: 1, project_id: projectId, project_name: project.name, blocks,
    diagnostics: blocks.flatMap(block => block.diagnostics.map(message => `${block.title}: ${message}`)) };
}
export const readProjectContextTool = {
  name: 'read_project_context',
  description: 'Read source-linked project CLAUDE.md context from project-local inception scaffold tickets and Accepted knowledge. Read-only; reports unresolved and undecided categories without inventing summaries.',
  inputSchema: { type: 'object' as const, properties: {} },
};
