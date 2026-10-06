// B-1072 — prose/structure contract for skills/harmony-fasttrack/SKILL.md. Mirrors the house
// convention (see harmony-stale-patch.contract.test.ts / start-work.contract.test.ts): asserts the
// frontmatter shape and pins the required phrases/sections, never a runtime test of the skill.

import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-fasttrack skill contract', () => {
  const skill = readSkill('harmony-fasttrack');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-fasttrack');
    expect(skill.frontmatter.description).toBeTruthy();
    expect(skill.frontmatter['allowed-tools']).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it('names all four phases', () => {
    expect(skill.body).toContain('Check phase');
    expect(skill.body).toContain('Plan-lite phase');
    expect(skill.body).toContain('Build phase');
    expect(skill.body).toContain('Record phase');
  });

  it('states the two-point eligibility contract: pre-work refuses on fail, defers the verify-walk unattested item', () => {
    const body = skill.body;
    expect(body).toMatch(/any `fail` verdict refuses before any work begins/i);
    expect(body).toMatch(/verify-walk item \(`unattested`\) does NOT refuse here/i);
    expect(body).toContain('deferred to the Record phase');
  });

  it('states the pre-PR-open re-check runs against the real diff (scope guard + eligibility)', () => {
    const body = skill.body;
    expect(body).toContain('immediately before `gh pr create`');
    expect(body).toContain('evaluateScopeBudget');
    expect(body).toContain('git diff --numstat');
    expect(body).toContain('git diff --name-only');
  });

  it('names harmony conduct as the escalation out of the fast track', () => {
    expect(skill.body).toContain('harmony conduct <ticket>');
  });

  it('never merges or records in the same invocation as Build (AC4)', () => {
    expect(skill.body).toMatch(/never merge, never record, in the same invocation/i);
  });

  it('leaves the branch and its commits intact on a failed pre-PR-open re-check (AC6)', () => {
    expect(skill.body.toLowerCase()).toContain('leave the branch');
  });

  it('determines Record phase purely from the ticket row, no carried session state (AC8)', () => {
    expect(skill.body).toMatch(/purely from[\s\S]{0,20}the ticket row/i);
    expect(skill.body).toContain('no carried session state');
  });

  it('quotes the ask-first rule for plugin/web targets verbatim', () => {
    expect(skill.body).toContain(
      'the workspace repo may be recorded without asking; for `plugin/` and `web/` the orchestrator ASKS the founder before recording, rather than silently taking the slow track.',
    );
  });

  it('states the no-conduct-breadcrumb rule plainly', () => {
    const body = skill.body;
    expect(body).toContain('conduct-sessions');
    expect(body.toLowerCase()).toMatch(/does not write/);
    expect(body.toLowerCase()).toContain("do not \"fix\" this by adding a breadcrumb".toLowerCase());
  });

  it('points at start-work O3 by reference rather than duplicating its mechanics', () => {
    expect(skill.body).toContain('`skills/start-work/SKILL.md`\'s **O3**');
  });
});
