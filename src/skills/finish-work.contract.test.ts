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
    // B-712: the merge floor (B-695) requires the REST merge form — GraphQL `gh pr merge`
    // does not honor bypass_pull_request_allowances and must never come back.
    expect(skill.body).toContain('pulls/<PR-number>/merge');
    expect(skill.body).toContain('merge_method=squash');
    expect(skill.body).not.toContain('gh pr merge ');
  });

  // New opinionated path.
  it('branches on mode and drives deploying + verifying', () => {
    expect(skill.body).toContain('get_project');
    expect(skill.body).toContain('opinionated');
    expect(skill.body.toLowerCase()).toContain('manual mode');
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('resolve_brief');       // release accept (clears gate) + verify accept
    expect(tools).toContain('compose_brief');       // verification-ack-pending
    expect(tools).toContain('advance_workflow');    // Built->Deployed AFTER deploy succeeds (F4)
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
    expect(tools).toContain('resolve_brief'); // accept → Deployed -> Verified
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
    // Tight anchor on the actual corrected claim ("list_subtasks selects … status … not … workflow_state")
    // so incidental "…workflow_state…" prose elsewhere in O0 can't satisfy it.
    expect(o0.toLowerCase()).toMatch(/list_subtasks.{0,15}selects.{0,40}status.{0,25}not.{0,25}workflow_state/);
    // …and that enumerating un-Verified children means get_task per child.
    expect(o0.toLowerCase()).toMatch(/get_task.{0,15}each child/);
  });

  // B-703: the verify gate must READ the acceptance criteria before it composes its brief.
  // WHY a structural test and not prose alone: prose is exactly what failed here. brief-authoring.md
  // §Verify has required the verify brief to be a runbook built from the ticket's ACs since B-660, yet
  // O3's recipe only ever called get_build_evidence_status — which returns booleans (`all_acs_checked`)
  // and selects only `id, checked`, so the AC TEXT never entered the session. The contract was
  // unsatisfiable by construction and no test noticed. This pins the ordering mechanically.
  const o3Section = (body: string): string => {
    const start = body.indexOf('### O3. Verify');
    expect(start, 'finish-work has no "### O3. Verify" section').toBeGreaterThan(-1);
    const rest = body.slice(start);
    const ends = [rest.search(/\n## /), rest.search(/\n---\s*\n/)].filter((i) => i > 0);
    return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
  };

  it('reads the acceptance criteria BEFORE composing the verify brief (the read must precede the compose)', () => {
    const o3 = o3Section(skill.body);
    const readIdx = o3.indexOf('list_acceptance_criteria');
    const composeIdx = o3.search(/mcp__harmony__compose_brief\s*\(\s*\{/);

    expect(
      readIdx,
      'O3 never calls list_acceptance_criteria — get_build_evidence_status cannot substitute for it: it ' +
        'returns booleans (all_acs_checked) and selects only `id, checked`, so the AC text never reaches ' +
        'the session and the §Verify runbook cannot be built (B-703)',
    ).toBeGreaterThan(-1);
    expect(composeIdx, 'O3 has no compose_brief call site — the verify brief is composed here').toBeGreaterThan(-1);
    expect(
      readIdx,
      'O3 composes the verify brief BEFORE reading the acceptance criteria. The read must precede the ' +
        'compose — a runbook composed from evidence booleans is the B-703 defect, not a runbook',
    ).toBeLessThan(composeIdx);
  });

  it('states the runbook requirement in O3 so a future edit cannot silently gut it (B-703)', () => {
    const o3 = o3Section(skill.body);
    // The runbook framing itself…
    expect(o3.toLowerCase(), 'O3 never says the verify brief is a runbook (brief-authoring.md §Verify)').toContain('runbook');
    // …pointing at the SSoT for its shape rather than restating the contract.
    expect(o3, 'O3 must point at brief-authoring.md as the runbook contract SSoT').toContain('brief-authoring.md');
    expect(o3, 'O3 must point specifically at the §Verify gate contract').toContain('§Verify');
    // …and the no-criteria case is handled honestly instead of rendering an empty list.
    expect(
      o3.toLowerCase(),
      'O3 must cover the no-acceptance-criteria ticket (umbrella / decision-only) rather than rendering an empty runbook',
    ).toMatch(/no acceptance criteria|empty runbook/);
    // …plus the re-entry freshness check, so a criterion edited during a long pause is re-read.
    expect(
      o3.toLowerCase(),
      'O3 must carry the re-entry freshness check — re-read the criteria when re-entering an already-paused verify gate',
    ).toMatch(/freshness/);
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

  // B-714: resume-vs-draft check closes the release-gate loop — a Built ticket that's already been
  // accepted out-of-band (browser, daemon re-fire) must resume straight into O2, not redraft the brief.
  it('O1 has a resume-vs-draft check that skips redrafting and goes straight to O2 when already accepted', () => {
    const body = skill.body;
    const o1Idx = body.indexOf('### O1.');
    const o2Idx = body.indexOf('### O2.');
    expect(o1Idx).toBeGreaterThan(-1);
    expect(o2Idx).toBeGreaterThan(o1Idx);
    const o1 = body.slice(o1Idx, o2Idx);
    // Mentions resuming, and explicitly instructs skipping the draft/compose in favor of O2.
    expect(o1.toLowerCase()).toMatch(/resume/);
    expect(o1.toLowerCase()).toMatch(/skip/);
    expect(o1.toLowerCase()).toMatch(/o2/);
    // Keyed on the detectable shape: Built + awaiting_human_input === false + no active brief.
    expect(o1).toContain("workflow_state === 'Built'");
    expect(o1).toContain('awaiting_human_input');
    expect(referencedHarmonyTools(o1)).toContain('get_brief');
    expect(referencedHarmonyTools(o1)).toContain('get_task');
  });

  // B-714: O2 branches on field_values.build_pr — a daemon-built PR merges over REST with no local
  // worktree, closing the daemon-built-PR gap that previously hard-required a worktree to merge at all.
  it('O2 branches on field_values.build_pr for a worktree-less REST merge (B-714)', () => {
    const body = skill.body;
    const o2Idx = body.indexOf('### O2.');
    const o3Idx = body.indexOf('### O3.');
    expect(o2Idx).toBeGreaterThan(-1);
    expect(o3Idx).toBeGreaterThan(o2Idx);
    const o2 = body.slice(o2Idx, o3Idx);
    // Branches on the B-722 recorded pushed-PR reference.
    expect(o2).toContain('build_pr');
    // Still uses the B-712 REST merge form (never gh pr merge's GraphQL path).
    expect(o2).toContain('pulls/<pr_number>/merge');
    expect(o2).toContain('merge_method=squash');
    // No checkout/rebase/force-push required on the build_pr-present path.
    expect(o2.toLowerCase()).toMatch(/no local worktree required/);
    expect(o2.toLowerCase()).toMatch(/no checkout, no rebase, no force-push/);
    // O2 itself must NOT reintroduce a hard "must be inside .worktrees/" precondition — that guard
    // stays scoped to Manual mode's pre-flight checks only, which O2 falls back to by reference.
    expect(o2.toLowerCase()).not.toMatch(/must be inside/);
    // The manual-mode fallback is referenced, not duplicated, for the no-build_pr-but-local-PR case.
    expect(o2.toLowerCase()).toMatch(/manual-mode merge sequence/);
    // The true no-diff case (B-265) advances without a merge step.
    expect(o2).toContain('B-265');
  });

  it('the verify gate FLOORS an empty acceptance-criteria set rather than only reporting it (B-747)', () => {
    const body = skill.body;
    // B-738 reached Verified with zero criteria on a brief that had DISPLAYED the incomplete-evidence
    // line and was accepted anyway. Detection was never the gap — blocking was. So the empty case must
    // be a floor, distinct in kind from the informational evidence signal around it.
    expect(body).toMatch(/has_acceptance_criteria/);
    expect(body).toMatch(/B-738/);
    expect(body.toLowerCase()).toMatch(/floor, not a signal/);
    // It refuses through the same answerable surface the build edge uses — never a raised exception.
    expect(body).toMatch(/elicitation round/i);
    // And it is explicitly the same predicate as the build gate's, not a second definition.
    expect(body.toLowerCase()).toMatch(/never a second definition/);
  });
});
