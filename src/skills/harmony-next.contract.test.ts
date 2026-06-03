import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-next skill contract', () => {
  const skill = readSkill('harmony-next');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-next');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('routes by awaiting_human_reason to the right activity skill', () => {
    expect(skill.body).toContain('awaiting_human_reason');
    expect(skill.body).toContain('resolve_brief');
    for (const r of ['clarification-draft', 'release-decision-pending', 'design-decision-draft']) {
      expect(skill.body).toContain(r);
    }
  });
  it('restricts inline accept to the pure gates and delegates the side-effecting ones (F1)', () => {
    // The side-effecting gates must be marked as delegated, not resolved inline.
    expect(skill.body.toLowerCase()).toContain('delegate');
    for (const r of ['decomposition-proposal', 'release-decision-pending', 'verification-ack-pending']) {
      expect(skill.body).toContain(r);
    }
    // The pure gates are explicitly the inline-accept set.
    expect(skill.body.toLowerCase()).toContain('pure gate');
  });
  it('routes a Stale ticket to the patch author (F3 — the §6.4 loop is built)', () => {
    expect(skill.body).toContain('harmony-stale-patch');
    expect(skill.body).toContain('stale-patch-review');
  });
  it('authors deferral knowledge before parking (F4 — deferral-as-knowledge)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    // graceful fallback: a defer with no rationale still parks (B-352)
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);
  });
  it('is scoped to the read-only discovery role', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
