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

  // B-876: the release brief drafted HERE is the same artefact the release gate surfaces, so it owes the
  // same frame. This template was the one release compose site that shipped unframed on the first pass —
  // an unframed release brief renders no act, no unproven residue and no evidence counts, which is exactly
  // the "the gate has no field for the act it authorizes" defect the frame exists to close. Pinned so the
  // two release compose sites (this one and finish-work's) cannot drift apart again.
  it('B-876: the release-brief template carries the release frame and passes changed_paths', () => {
    const body = skill.body;
    // The frame, on the same compose call as the release reason.
    expect(body).toMatch(/frame:\s*\{\s*\n?\s*kind:\s*"release"/);
    for (const field of ['act:', 'unproven:', 'evidence_status:', 'risk_classes:']) {
      expect(body, `the release frame template is missing ${field}`).toContain(field);
    }
    // `lands_in` is an enum precisely so the brief cannot claim production while merging to main.
    expect(body).toMatch(/lands_in:\s*"staging"/);
    // changed_paths is what compose derives frame.risk_classes from — the build gate has the diff.
    expect(body).toContain('changed_paths:');
    // …and the skill must say the field is OVERWRITTEN at compose, so nobody hand-authors a risk set.
    expect(body.toLowerCase()).toMatch(/overwrit\w+/);
    // Point at the single field-by-field reference rather than carrying a second copy of it.
    expect(body).toContain('The release frame (B-876)');
    // The B-874 must-haves and the bot-approval line are NOT displaced by the frame.
    expect(body).toContain('Not proven by this build:');
    expect(body).toContain('needs your approval on GitHub before it can merge');
    expect(body).toMatch(/recommend:\s*\{\s*text:\s*"Ship it/);
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

  // B-722: the build gate must produce and verify a real pushed PR before Built (the B-713
  // phantom-build class), and preserve tested work on any failure (the B-668 discarded-work
  // class). These pins hold O3's ordered artefact step and failure path in place.
  describe('B-722: O3 artefact step + failure path', () => {
    const body = skill.body;

    it('carries the ordered commit→push→verify→PR→record step, in order, before advancing', () => {
      const iVerifyPush = body.indexOf('git ls-remote origin');
      const iPrCreate = body.indexOf('gh pr create');
      const iRecord = body.indexOf('field_values: { build_pr');
      const iAdvance = body.indexOf('activity: "building"');
      expect(iVerifyPush).toBeGreaterThan(-1);
      expect(iPrCreate).toBeGreaterThan(iVerifyPush);
      expect(iRecord).toBeGreaterThan(iPrCreate);
      expect(iAdvance).toBeGreaterThan(iRecord);
    });

    it('O3 does the push-instructing (the B-719 push-only-when-instructed contract stays intact)', () => {
      expect(body).toMatch(/INSTRUCT the build subagent to commit and\s+push/);
      expect(body).toContain('instructing party');
    });

    it('records the ref only from live-verified outputs and keys evidence on it', () => {
      expect(body).toMatch(/written ONLY from the just-verified\s+live outputs/);
      expect(body).toContain('has_pushed_pr');
    });

    it('failure path: patch-first ladder (diff is a read), WIP-push upgrade, attach fallback, park', () => {
      const iPatch = body.indexOf('git diff HEAD');
      const iWip = body.indexOf('HEAD:wip/B-<n>');
      const iAttach = body.indexOf('attach_file');
      const iPark = body.indexOf('activity: "parking"');
      expect(iPatch).toBeGreaterThan(-1);
      expect(iWip).toBeGreaterThan(iPatch);
      expect(iAttach).toBeGreaterThan(iWip);
      expect(iPark).toBeGreaterThan(iAttach);
      expect(body).toMatch(/works even when `git commit` itself was denied/);
    });

    it('never a PR-less release brief; the release brief references the recorded PR', () => {
      expect(body).toMatch(/NEVER composes a release brief without the recorded `build_pr` reference/);
      expect(body).toContain('Ship the built artefact — PR <pr_url>');
    });
  });

  describe('acceptance-criteria floor at the build edge (B-747)', () => {
    const body = skill.body;

    it('the floor check runs BEFORE any build work — position, not just presence', () => {
      // THE REGRESSION THIS EXISTS TO CATCH. B-747 first shipped this check sitting next to the
      // `advance_workflow` at the END of O3, so a criteria-less ticket created a worktree, implemented,
      // committed, pushed and opened a PR, and only THEN got refused. The floor recorded the waste
      // instead of preventing it — while every presence-only assertion still passed.
      //
      // The design called for TWO placements doing two different jobs: the substrate guard on the
      // Planned->Built edge stops the ESCAPE (it fires after the build), and this check stops the WORK.
      // Asserting only that the check exists cannot tell those apart, so assert the ORDER.
      const o3 = body.indexOf('### O3. Build (Planned');
      expect(o3, 'O3 section not found').toBeGreaterThan(-1);

      const precheck = body.indexOf('PRE-CHECK the acceptance-criteria floor, BEFORE any build work begins', o3);
      const worktree = body.indexOf('create the isolated worktree', o3);
      const advance = body.indexOf('activity: "building"', o3);

      expect(precheck, 'the start-of-build floor check is missing').toBeGreaterThan(-1);
      expect(worktree, 'worktree creation not found in O3').toBeGreaterThan(-1);
      expect(advance, 'the building advance not found in O3').toBeGreaterThan(-1);

      // The whole point: the check precedes the first thing that costs anything.
      expect(precheck, 'the floor check must precede worktree creation').toBeLessThan(worktree);
      expect(worktree).toBeLessThan(advance);
    });

    it('does NOT re-add a second floor check next to the advance', () => {
      // A duplicate next to the advance is how the early check got dropped the first time: both blocks
      // looked correct in isolation, and the late one satisfied every presence assertion on its own.
      expect(body).toMatch(/deliberately not here/i);
      expect(body).not.toMatch(/\*\*Then PRE-CHECK the acceptance-criteria floor before advancing/);
    });

    it('PRE-CHECKS the floor before advancing to Built, and refuses via an elicitation round', () => {
      // The pre-check is what makes the refusal answerable. Letting the substrate guard raise instead
      // reaches a daemon leg as a dirty exit, which parks the conduction and pages an operator.
      expect(body).toMatch(/has_acceptance_criteria/);
      expect(referencedHarmonyTools(body)).toContain('get_build_evidence_status');
      expect(body).toMatch(/elicitation round/i);
      // Presence, never the all-checked predicate (that is B-560's deferred evidence test).
      expect(body).toMatch(/PRESENCE only/);
      // Both exemptions are honoured via exempt_reason rather than re-derived here.
      expect(body).toMatch(/exempt_reason/);
      // And the guard is named as the backstop, not the mechanism.
      expect(body.toLowerCase()).toMatch(/never swallow the guard's error/);
    });
  });
});
