import { beforeEach, describe, expect, it, vi } from 'vitest';
import { milestoneQuestionPreview, questionProjection, saveKnowledgeQuestion, importKnowledgeQuestions,
  previewKnowledgeQuestions, missingQuestionCapability } from './knowledge-questions.js';
import { decodeClaim } from './knowledge-claim.js';

beforeEach(() => { delete process.env.HARMONY_CONDUCTION_ID; delete process.env.HARMONY_LEG; });
const milestone = { id: 'milestone', name: 'Future themes', description: '- QA-1 — multi daemon routing\n- A second theme\n\nMoved out: a shipped feature' };

describe('honest question projection', () => {
  it('separates accepted questions from decisions and implementation', () => {
    expect(questionProjection({ madr: { question: { version: 1, state: 'parked', scope: 'product' } } }))
      .toEqual({ question_state: 'parked', question_scope: 'product', answer: 'not yet decided', resulting_decision_id: null });
    expect(questionProjection({ madr: { question: { version: 1, state: 'decided', scope: 'deployment' } }, superseded_by: 'decision' }))
      .toMatchObject({ question_state: 'decided', resulting_decision_id: 'decision', answer: 'decided; see resulting decision' });
    expect(questionProjection(null)).toEqual({});
    expect(questionProjection({ madr: { question: { version: 2, state: 'open' } } })).toEqual({});
  });
});

describe('reviewed milestone import', () => {
  it('proposes source-attributed parked entries without deciding or approving them, generically', () => {
    const first = milestoneQuestionPreview('project-a', milestone);
    const second = milestoneQuestionPreview('project-b', { ...milestone, id: 'independent-milestone' });
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0]).toMatchObject({ key: 'QA-1', approved: false, state: 'parked', scope: 'product', source_excerpt: '- QA-1 — multi daemon routing' });
    expect(first.entries[0].content).toContain('not evidence of shipped');
    expect(decodeClaim(first.entries[0].content)).toMatchObject({ claim_source: 'derived' });
    expect(first.warnings[0]).toContain('since been decided');
    expect(second.project_id).toBe('project-b');
    expect(second.entries).toEqual(first.entries);
    expect(milestoneQuestionPreview('project-a', milestone)).toEqual(first);
    expect(milestoneQuestionPreview('project-a', { ...milestone, description: `${milestone.description}\nchanged` }).source_fingerprint).not.toBe(first.source_fingerprint);
  });
  it('rejects duplicate source identities instead of hiding them', () => {
    expect(() => milestoneQuestionPreview('p', { ...milestone, description: '- QA-1 one\n- QA-1 two' })).toThrow('Duplicate theme key');
  });
  it('preview only reads its project milestone', async () => {
    const chain: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: milestone, error: null }) };
    const client: any = { from: vi.fn().mockReturnValue(chain), rpc: vi.fn() };
    const manifest = await previewKnowledgeQuestions(client, 'p', { milestone_id: 'milestone' });
    expect(chain.eq).toHaveBeenCalledWith('project_id', 'p');
    expect(client.rpc).not.toHaveBeenCalled();
    expect(manifest.entries.every(item => !item.approved)).toBe(true);
  });
  it('never applies a manifest to another project or retries a refused import', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ error: { code: '42501', message: 'permission denied' } }) };
    const manifest = milestoneQuestionPreview('p', milestone);
    await expect(importKnowledgeQuestions(client, 'other', { manifest })).rejects.toThrow('another project');
    expect(client.rpc).not.toHaveBeenCalled();
    await expect(importKnowledgeQuestions(client, 'p', { manifest })).rejects.toThrow('permission denied');
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('capability-aware writes', () => {
  it('does not downgrade missing capability or permission failures into an ordinary decision write', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ error: { code: 'PGRST202' } }) };
    await expect(saveKnowledgeQuestion(client, 'p', { state: 'open', scope: 'product', title: 'Q', content: 'Unknown' })).rejects.toThrow('unavailable');
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(missingQuestionCapability({ code: '42501' })).toBe(false);
    expect(missingQuestionCapability({ code: '57014' })).toBe(false);
  });
  it('passes optimistic state/link controls atomically and keeps the written question if embedding fails', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ data: { id: 'q', title: 'Question', content: 'Unknown', madr: { question: { version: 1, state: 'decided', scope: 'product' } }, superseded_by: 'd' }, error: null }),
      functions: { invoke: vi.fn().mockRejectedValue(new Error('offline')) } };
    const result = await saveKnowledgeQuestion(client, 'p', { state: 'decided', question_id: 'q', expected_updated_at: '2026-10-22T00:00:00Z', resulting_decision_id: 'd', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_question_save', expect.objectContaining({ p_question_id: 'q', p_decision_id: 'd', p_expected_updated_at: '2026-10-22T00:00:00Z' }));
    expect(result).toMatchObject({ question_state: 'decided', resulting_decision_id: 'd' });
  });
});
