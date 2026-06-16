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

  // B-471: the PR-less umbrella verify path (a decomposed parent whose work shipped in its children).
  it('documents the PR-less umbrella verify branch (skip merge; compose + resolve the verify brief)', () => {
    const body = skill.body;
    // Detection: has children AND no open PR for its branch.
    expect(referencedHarmonyTools(body)).toContain('list_subtasks');
    expect(body.toLowerCase()).toContain('umbrella');
    // It surfaces via the trigger's verification-ack-pending with a null brief…
    expect(body).toContain('verification-ack-pending');
    // …and the merge/deploy steps are skipped (no code to merge — children shipped their own PRs).
    expect(body.toLowerCase()).toMatch(/skip o1\/o2|skip the (release|merge)|no code to merge|no git/i);
    // It composes the missing verify brief, then resolves on accept.
    const tools = referencedHarmonyTools(body);
    expect(tools).toContain('get_brief');     // detect the null brief
    expect(tools).toContain('compose_brief'); // compose it when null
    expect(tools).toContain('resolve_brief'); // accept → Released -> Verified
    // Edge: a still-Decomposed umbrella (children in flight) is NOT verified.
    expect(body).toContain('Decomposed');
  });

  // B-471 review fold #1 (MINOR): detect the umbrella via the authoritative marker, not a fragile proxy.
  it('detects the umbrella via the awaiting_human_ref.kind marker as the PRIMARY key (not gh pr view)', () => {
    const body = skill.body;
    // The purpose-built marker must be named as the authoritative/primary detection signal — scoped to
    // the O0 section so a stray mention elsewhere can't satisfy it.
    const o0Idx = body.indexOf('### O0.');
    expect(o0Idx).toBeGreaterThan(-1);
    const o1Idx = body.indexOf('### O1.');
    expect(o1Idx).toBeGreaterThan(o0Idx);
    const o0 = body.slice(o0Idx, o1Idx);
    expect(o0).toContain('umbrella-auto-verify');     // the marker value
    expect(o0).toContain('awaiting_human_ref');        // …carried on this field
    expect(o0.toLowerCase()).toMatch(/primary|authoritative/); // …as the primary/authoritative signal
    expect(referencedHarmonyTools(o0)).toContain('get_task'); // read via get_task, not gh pr view alone
    // "no open PR" is corroboration only — explicitly demoted from primary signal.
    expect(o0.toLowerCase()).toMatch(/corroborat|confirmation|not.*primary|unreliable/);
  });

  // B-471 review fold #2 (MINOR): the still-Decomposed diagnostic must NOT claim list_subtasks reads
  // workflow_state — it selects kanban `status`. To enumerate un-Verified children, get_task each child.
  it('does not claim list_subtasks reveals which children are Verified (it selects status, not workflow_state)', () => {
    const body = skill.body;
    const o0Idx = body.indexOf('### O0.');
    const o1Idx = body.indexOf('### O1.');
    const o0 = body.slice(o0Idx, o1Idx);
    // The edge bullet must call out that workflow_state (where Verified lives) is NOT on list_subtasks…
    expect(o0).toContain('workflow_state');
    expect(o0.toLowerCase()).toMatch(/list_subtasks selects|not.*workflow_state|status.*not.*workflow_state/);
    // …and that enumerating un-Verified children means get_task per child.
    expect(o0.toLowerCase()).toMatch(/get_task each child|each child.*get_task|get_task.*child/);
  });

  // B-471 review fold #3 (NIT): state the umbrella's task_id provenance (ticket id passed to the skill,
  // NOT .harmony-task.json, since an umbrella has no worktree of its own).
  it("states the umbrella's task_id comes from the ticket id passed in, not .harmony-task.json", () => {
    const body = skill.body;
    const o0Idx = body.indexOf('### O0.');
    const o1Idx = body.indexOf('### O1.');
    const o0 = body.slice(o0Idx, o1Idx);
    expect(o0).toContain('.harmony-task.json');
    expect(o0.toLowerCase()).toMatch(/no worktree|ticket id (you were invoked with|passed)|do \*\*not\*\* read `task_id`|not.*\.harmony-task\.json/);
  });
});
