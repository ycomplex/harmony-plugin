import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('start-work skill contract (evolved)', () => {
  const skill = readSkill('start-work');

  it('still has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('start-work');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  // Regression guard: the manual-mode path is preserved.
  it('preserves the manual-mode flow', () => {
    expect(skill.body).toContain('using-git-worktrees');
    expect(skill.body).toContain('In Progress');
    expect(skill.body).toContain('.harmony-task.json');
  });

  // New opinionated path.
  it('branches on project mode and drives the opinionated lifecycle', () => {
    expect(skill.body).toContain('get_project');
    expect(skill.body).toContain('opinionated');
    expect(skill.body.toLowerCase()).toContain('manual mode');
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('advance_workflow');   // Planned -> Built on tests pass
    expect(tools).toContain('compose_brief');       // plan-draft + release-decision-pending
    expect(tools).toContain('resolve_brief');       // Designed -> Planned on plan accept
    expect(skill.body).toContain('plan-draft');
    expect(skill.body).toContain('release-decision-pending');
    // F4 guard: the release brief must carry pending_activity: null (accept is the human's "go";
    // Built->Deployed is SYSTEM-on-deploy via finish-work, not the accept). An inverted body that
    // set pending_activity:'deploying' here would reintroduce the B-60 "Deployed before deploy" bug.
    expect(skill.body).toMatch(/release-decision-pending",\s*pending_activity:\s*null/);
  });
  it('carries the build role profile (can commit; cannot author design knowledge)', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/record_decision/);
  });

  // B-554: the "design is wrong" recipe must route through the human-ratified revise-scope
  // flow (harmony-revise-scope --to design), NOT a raw advance_workflow(revising-designing) —
  // which both named the wrong activity (revising-designing re-opens PLAN, not design) and
  // bypassed human ratification + the supersession decision-trail.
  it('routes a design-reopen through harmony-revise-scope, not a raw advance_workflow(revising-designing) [B-554]', () => {
    expect(skill.body).not.toMatch(/advance_workflow\([^)]*revising-designing/);
    expect(skill.body).not.toMatch(/activity:\s*["']revising-designing["']/);
    expect(skill.body).toContain('harmony-revise-scope');
    expect(skill.body).toMatch(/--to\s+design/);
  });
});
