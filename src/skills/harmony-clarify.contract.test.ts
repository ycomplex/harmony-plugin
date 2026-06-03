import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-clarify skill contract', () => {
  const skill = readSkill('harmony-clarify');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-clarify');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('runs the full gate loop', () => {
    const tools = referencedHarmonyTools(skill.body);
    for (const t of ['query_knowledge', 'record_decision', 'reference_knowledge', 'compose_brief', 'resolve_brief']) {
      expect(tools, `missing ${t}`).toContain(t);
    }
  });
  it('encodes the knowledge-query + research-first discipline', () => {
    expect(skill.body).toContain('query_knowledge');
    expect(skill.body.toLowerCase()).toMatch(/load-bearing|research-first|surface the gap/);
  });
  it('composes the clarification with the correct reason + activity', () => {
    expect(skill.body).toContain('clarification-draft');
    expect(skill.body).toContain('clarifying');
  });
  it('authors deferral knowledge on the defer path (F4 — deferral-as-knowledge)', () => {
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (B-352)
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
