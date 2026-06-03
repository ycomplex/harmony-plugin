import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-queue skill contract', () => {
  const skill = readSkill('harmony-queue');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-queue');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('keys off BOTH queue signals — awaiting_human_input AND stale (state-machine §6.4–§6.5)', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('query_tasks');
    expect(tools).toContain('get_brief');
    expect(skill.body).toContain('awaiting_human_input');
    expect(skill.body).toContain('stale');
  });
  it('is scoped to the read-only discovery role', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
