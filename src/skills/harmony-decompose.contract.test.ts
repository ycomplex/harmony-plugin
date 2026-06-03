import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-decompose skill contract', () => {
  const skill = readSkill('harmony-decompose');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-decompose');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('creates children and advances via the substrate', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('manage_subtasks');
    expect(tools).toContain('compose_brief');
    expect(tools).toContain('resolve_brief');
    expect(tools).toContain('advance_workflow');
    expect(skill.body).toContain('decomposition-proposal');
  });
  it('handles the explicit "no decomposition needed" decision', () => {
    expect(skill.body.toLowerCase()).toContain('no decomposition');
  });
  it('encodes the knowledge-query discipline', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
  });
  it('authors deferral knowledge on the defer path (F4 — deferral-as-knowledge)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (B-352)
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
