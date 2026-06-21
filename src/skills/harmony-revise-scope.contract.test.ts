import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-revise-scope skill contract', () => {
  const skill = readSkill('harmony-revise-scope');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-revise-scope');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it('reads the run + its gate decisions, then composes a revise-scope-review brief', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('get_task');
    expect(tools).toContain('list_ticket_knowledge');
    expect(tools).toContain('compose_brief');
    // the new brief reason this skill files under:
    expect(skill.body).toContain('revise-scope-review');
  });

  it('queries domain knowledge before drafting (knowledge discipline)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
  });

  it('names the three raise-paths (standalone skill, gate-pause verb, agent-proposed)', () => {
    const body = skill.body.toLowerCase();
    expect(body).toContain('/harmony-revise-scope');
    expect(body).toMatch(/gate pause|gate-pause|controlled gate pause/);
    expect(body).toMatch(/agent-proposed|proposed by the agent|conductor.*recommend|recommendation/);
  });

  it('executes ONLY on a human accept — never reverts state on its own (contract-1)', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/human-decided|human accept|executes only on a human accept/);
    // It must state it never calls advance_workflow without an accept.
    expect(body).toMatch(/never calls? .*advance_workflow|never.*advance_workflow.*without/);
    expect(skill.body).toContain('advance_workflow');
  });

  it('the drafted brief names target gate + broadened scope + supersede-list vs keep-list', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/target (upstream )?gate/);
    expect(body).toMatch(/broadened[- ]scope|broadened scope/);
    expect(body).toMatch(/supersede-list/);
    expect(body).toMatch(/keep-list/);
  });

  it('ACCEPT supersedes (not deletes) only the invalidated decisions and reverts via a revising-* back-edge', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('record_decision');
    expect(tools).toContain('supersede_decision');
    expect(tools).toContain('advance_workflow');
    const body = skill.body.toLowerCase();
    // the back-edge activities:
    expect(body).toMatch(/revising-clarifying/);
    expect(body).toMatch(/revising-decomposing/);
    // supersede, never delete; preserves the Decision Trail.
    expect(body).toMatch(/supersede.*never delete|never delete|preserve.*decision trail|decision trail/);
    // the guard auto-clears the orphaned brief (B-482) AND the stale flag — the skill does NOT do it manually.
    expect(body).toMatch(/auto-clear|auto-clos/);
    expect(body).toContain('b-482');
    expect(body).toMatch(/stale/);
  });

  it('REJECT is a no-op — no state change, no supersede, no knowing-divergence record', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/no-op|no op/);
    // unlike stale-patch, reject records NO knowing-divergence.
    expect(body).toMatch(/no.*knowing-divergence|without.*knowing-divergence|not.*knowing-divergence/);
    // explicit: do not supersede / revert / park on reject.
    expect(body).toMatch(/do not supersede|do not revert|untouched/);
  });

  it('reports ready-to-re-conduct-forward after accept', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/re-conduct|re-run.*forward|ready to.*conduct|drives? .*forward/);
  });

  it('carries the read-only discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
