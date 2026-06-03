import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-research skill contract', () => {
  const skill = readSkill('harmony-research');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-research');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('ingests research as Asserted knowledge with research provenance', () => {
    const tools = referencedHarmonyTools(skill.body);
    // ingests as a decision or a fact:
    expect(tools.some((t) => t === 'record_decision' || t === 'assert_fact')).toBe(true);
    expect(tools).toContain('advance_workflow');
    expect(skill.body).toContain('research');           // source_type
    expect(skill.body).toContain('review_by');
    expect(skill.body).toContain('researching');        // the activity
  });
  it('is the human-relayed v1 hand-off (never auto-Accepted)', () => {
    expect(skill.body).toContain('Asserted');
    expect(skill.body.toLowerCase()).toMatch(/paste|relay|run these/);
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
  });
});
