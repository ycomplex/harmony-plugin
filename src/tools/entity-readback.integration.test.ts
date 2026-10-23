/** Explicit opt-in, disposable LOCAL Supabase smoke. Never targets a hosted board. */
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { recordDecision, queryEntities } from './knowledge.js';
import { referenceKnowledge, listTicketKnowledge, linkTicketEntities } from './workflow.js';
import { applyAcceptanceEventPayload } from './acceptance-events.js';
const url = process.env.HARMONY_ENTITY_TEST_URL;
it.skipIf(!url)('round-trips recorded names and explicit identities through the real plugin and database', async () => {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url!)) throw new Error('This destructive fixture is local-only');
  const fixtureClient = createClient(url!, process.env.HARMONY_ENTITY_TEST_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const client = createClient(url!, process.env.HARMONY_ENTITY_TEST_ANON_KEY!, { auth: { persistSession: false } });
  const { data: auth, error } = await client.auth.signInWithPassword({ email: 'dev@harmony.local', password: 'devpassword123' });
  if (error) throw error;
  const user = auth.user!.id;
  async function insert(table: string, row: Record<string, unknown>) {
    const { data, error } = await (table === 'pending_acceptance_events' ? fixtureClient : client).from(table).insert(row).select('*').single();
    if (error) throw error;
    return data;
  }
  const created = await client.rpc('create_workspace_with_owner', { _name: 'B1255 disposable smoke' });
  if (created.error) throw created.error;
  const workspace = { id: created.data as string };
  try {
    const project = await insert('projects', { workspace_id: workspace.id, name: 'B1255', key: 'B1255', created_by: user });
    const task = await insert('tasks', { project_id: project.id, title: 'Readback fixture', created_by: user });
    const feature = await insert('knowledge_entities', { workspace_id: workspace.id, project_id: project.id, kind: 'feature', name: 'Knowledge' });
    const concept = await insert('knowledge_entities', { workspace_id: workspace.id, project_id: project.id, kind: 'concept', name: 'Knowledge' });
    const named = await insert('knowledge_entities', { workspace_id: workspace.id, project_id: project.id, kind: 'concept', name: 'Unique named concept' });
    const otherProject = await insert('projects', { workspace_id: workspace.id, name: 'Other', key: 'OTHER', created_by: user });
    const outside = await insert('knowledge_entities', { workspace_id: workspace.id, project_id: otherProject.id, kind: 'feature', name: 'Other project identity' });
    await expect(queryEntities(client, project.id, { entity_id: outside.id })).rejects.toThrow('unavailable');
    const decision = await recordDecision(client, project.id, user, { type: 'convention', title: 'Local readback contract', content: 'Names resolve to persistent identities.', scope: 'product', status: 'Accepted', claim: 'Names resolve to persistent identities.', affected_entity_names: [named.name, named.name] });
    await referenceKnowledge(client, project.id, { task_id: task.id, decision_id: decision.id });
    let entries = await listTicketKnowledge(client, project.id, { task_id: task.id });
    expect(entries[0].affected_entities.map(entity => entity.entity_id)).toEqual([named.id]);
    await expect(queryEntities(client, project.id, { name: 'Knowledge' })).rejects.toThrow(feature.id);
    expect((await queryEntities(client, project.id, { name: 'Knowledge', kind: 'feature' })).map(entity => entity.id)).toEqual([feature.id]);
    await expect(linkTicketEntities(client, project.id, { task_id: task.id, decision_id: decision.id, entity_names: ['Knowledge'] })).rejects.toThrow('Candidates');
    const beforeEdges = await client.from('ticket_implements_entity').select('entity_id').eq('task_id', task.id);
    expect(beforeEdges.error).toBeNull();
    expect(beforeEdges.data).toEqual([]);
    await linkTicketEntities(client, project.id, { task_id: task.id, decision_id: decision.id, entities: [{ entity_id: feature.id }, { name: 'Knowledge', kind: 'concept' }, { entity_id: named.id }] });
    entries = await listTicketKnowledge(client, project.id, { task_id: task.id });
    expect(entries[0].affected_entities.map(entity => entity.entity_id).sort()).toEqual([named.id, feature.id, concept.id].sort());
    const batch = await listTicketKnowledge(client, project.id, { task_ids: [task.id] });
    expect(batch.tickets[0].entries[0].affected_entities.map(entity => entity.entity_id).sort()).toEqual(entries[0].affected_entities.map(entity => entity.entity_id).sort());
    const brief = await insert('briefs', { task_id: task.id, reason: 'design-decision-draft', content: 'Explicit entity', status: 'accepted', created_by: user });
    const event = await insert('pending_acceptance_events', { task_id: task.id, brief_id: brief.id, reason: 'design-decision-draft', payload: { payload: [{ write_kind: 'entity_link', ref: 'explicit-id', entity_id: feature.id, kind: 'feature', decision_id: decision.id }] } });
    const applied = await applyAcceptanceEventPayload(client, event);
    expect(applied.applied).toBe(1);
    expect((await applyAcceptanceEventPayload(client, event)).applied).toBe(0);
  } finally {
    const { error } = await client.from('workspaces').delete().eq('id', workspace.id);
    if (error) throw error;
    await client.auth.signOut();
  }
}, 60000);
