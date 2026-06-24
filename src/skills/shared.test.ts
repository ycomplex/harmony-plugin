import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill, readSharedDoc, referencedHarmonyTools } from './skill-contract.js';

const SKILLS = join(process.cwd(), 'skills');

describe('skill-contract helper', () => {
  it('parses frontmatter + body of an existing skill', () => {
    const s = readSkill('start-work');
    expect(s.frontmatter.name).toBe('start-work');
    expect(s.body.length).toBeGreaterThan(100);
  });
  it('extracts referenced harmony tools from a body', () => {
    const tools = referencedHarmonyTools('call mcp__harmony__get_task then mcp__harmony__update_task');
    expect(tools).toEqual(expect.arrayContaining(['get_task', 'update_task']));
  });
  it('readSharedDoc reads a harmony-shared reference doc', () => {
    expect(readSharedDoc('knowledge-discipline').length).toBeGreaterThan(100);
  });
});

describe('shared references', () => {
  it('knowledge-discipline names all six domains', () => {
    const doc = readFileSync(join(SKILLS, 'harmony-shared/knowledge-discipline.md'), 'utf8');
    for (const d of ['engineering', 'operations', 'data', 'product', 'customer', 'process']) {
      expect(doc).toContain(d);
    }
    expect(doc.toLowerCase()).toContain('research-first');
  });
  it('role-profiles names the four agent-model §3 profiles', () => {
    const doc = readFileSync(join(SKILLS, 'harmony-shared/role-profiles.md'), 'utf8');
    for (const p of ['harmony-discovery', 'harmony-build', 'harmony-release', 'harmony-verify']) {
      expect(doc).toContain(p);
    }
  });
});

// B-545: the canonical gate routing is the single source of truth (no longer hand-copied into
// harmony-next + harmony-conduct). These assertions live HERE, at the SSoT, so the two skill
// contract tests no longer re-duplicate the routing facts.
describe('gate-routing (B-545 SSoT)', () => {
  const doc = readSharedDoc('gate-routing');

  it('records every forward + terminal workflow_state', () => {
    for (const state of [
      'Captured', 'Idea', 'Clarified', 'Decomposed', 'Designed',
      'Planned', 'Built', 'Released', 'Verified', 'Parked', 'Cancelled',
    ]) {
      expect(doc, `gate-routing.md missing state ${state}`).toContain(state);
    }
  });

  it('names every owning skill in the forward path (+ the off-path stale author)', () => {
    for (const skill of [
      'harmony-clarify', 'harmony-decompose', 'harmony-design-decide',
      'start-work', 'finish-work', 'harmony-stale-patch',
    ]) {
      expect(doc, `gate-routing.md missing owning skill ${skill}`).toContain(skill);
    }
  });

  it('marks release + verify as the hard floor (always human)', () => {
    expect(doc.toLowerCase()).toContain('hard floor');
    // The release/verify rows carry the hard-floor marking.
    expect(doc).toMatch(/release[\s\S]*always human|always human[\s\S]*release/i);
    expect(doc.toLowerCase()).toContain('verify');
  });

  it('classifies each brief reason as pure (inline) vs side-effecting (delegated)', () => {
    const lower = doc.toLowerCase();
    expect(lower).toContain('pure');
    expect(lower).toMatch(/side-effecting/);
    for (const pure of ['clarification-draft', 'design-decision-draft', 'plan-draft']) {
      expect(doc, `gate-routing.md missing pure reason ${pure}`).toContain(pure);
    }
    for (const side of ['decomposition-proposal', 'release-decision-pending', 'verification-ack-pending']) {
      expect(doc, `gate-routing.md missing side-effecting reason ${side}`).toContain(side);
    }
  });

  it('carries the B-446 human-facing release/verify gate vocabulary', () => {
    expect(doc.toLowerCase()).toContain('release gate');
    expect(doc).toContain('B-446');
  });
});
