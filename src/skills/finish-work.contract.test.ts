import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('finish-work skill contract (evolved)', () => {
  const skill = readSkill('finish-work');

  it('still has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('finish-work');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  // Regression guard: the manual-mode merge sequence is preserved.
  it('preserves the manual-mode merge sequence', () => {
    expect(skill.body).toContain('Pre-flight checks');
    expect(skill.body).toContain('git rebase origin/main');
    expect(skill.body).toContain('--squash');
  });

  // New opinionated path.
  it('branches on mode and drives releasing + verifying', () => {
    expect(skill.body).toContain('get_project');
    expect(skill.body).toContain('opinionated');
    expect(skill.body.toLowerCase()).toContain('manual mode');
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('resolve_brief');       // release accept (clears gate) + verify accept
    expect(tools).toContain('compose_brief');       // verification-ack-pending
    expect(tools).toContain('advance_workflow');    // Built->Released AFTER deploy succeeds (F4)
    expect(skill.body).toContain('release-decision-pending');
    expect(skill.body).toContain('verification-ack-pending');
  });
  it('carries the release role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/record_decision/);
  });
});
