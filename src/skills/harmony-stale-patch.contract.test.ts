import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-stale-patch skill contract', () => {
  const skill = readSkill('harmony-stale-patch');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-stale-patch');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('reads the Stale ticket + its referenced knowledge, then composes/resolves a patch brief', () => {
    const tools = referencedHarmonyTools(skill.body);
    // reads the Stale ticket (get_task, or query_tasks({stale:true}) when picking one up)
    expect(tools.some((t) => t === 'get_task' || t === 'query_tasks')).toBe(true);
    expect(tools).toContain('list_ticket_knowledge');
    expect(tools).toContain('compose_brief');
    expect(tools).toContain('resolve_brief');
    // the §6.4 producer signature:
    expect(skill.body).toContain('stale_ref');
    expect(skill.body).toContain('stale-patch-review');
  });
  it('queries domain knowledge before drafting the patch (knowledge discipline)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
  });
  it('maps accept (clear Stale) and defer (reject / knowing-divergence — does NOT park)', () => {
    expect(skill.body).toContain("command: 'accept'");
    expect(skill.body).toContain("command: 'defer'");
    expect(skill.body.toLowerCase()).toContain('knowing-divergence');
  });
  it('carries the read-only discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
