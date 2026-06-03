import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';

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
