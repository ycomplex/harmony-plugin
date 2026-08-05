import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-revise-scope skill contract', () => {
  const skill = readSkill('harmony-revise-scope');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-revise-scope');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it('reads the run + its gate decisions, then composes a revise-scope-review brief', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('get_task');
    expect(tools).toContain('list_ticket_knowledge');
    expect(tools).toContain('compose_brief');
    // the new brief reason this skill files under:
    expect(skill.body).toContain('revise-scope-review');
  });

  it('queries domain knowledge before drafting (knowledge discipline)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
  });

  it('names the three raise-paths (standalone skill, gate-pause verb, agent-proposed)', () => {
    const body = skill.body.toLowerCase();
    expect(body).toContain('/harmony-revise-scope');
    expect(body).toMatch(/gate pause|gate-pause|controlled gate pause/);
    expect(body).toMatch(/agent-proposed|proposed by the agent|conductor.*recommend|recommendation/);
  });

  it('executes ONLY on a human accept — never reverts state on its own (contract-1)', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/human-decided|human accept|executes only on a human accept/);
    // It must state it never calls advance_workflow without an accept.
    expect(body).toMatch(/never calls? .*advance_workflow|never.*advance_workflow.*without/);
    expect(skill.body).toContain('advance_workflow');
  });

  it('the drafted brief names target gate + broadened scope + supersede-list vs keep-list', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/target (upstream )?gate/);
    expect(body).toMatch(/broadened[- ]scope|broadened scope/);
    expect(body).toMatch(/supersede-list/);
    expect(body).toMatch(/keep-list/);
  });

  it('ACCEPT supersedes (not deletes) only the invalidated decisions and reverts via a revising-* back-edge', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('supersede_decision');
    expect(tools).toContain('advance_workflow');
    const body = skill.body.toLowerCase();
    // the back-edge activities (all three targets):
    expect(body).toMatch(/revising-promoting/);
    expect(body).toMatch(/revising-clarifying/);
    expect(body).toMatch(/revising-decomposing/);
    // supersede, never delete; preserves the Decision Trail.
    expect(body).toMatch(/supersede.*never delete|never delete|preserve.*decision trail|decision trail/);
    // the guard auto-clears the orphaned brief (B-482) AND the stale flag — the skill does NOT do it manually.
    expect(body).toMatch(/auto-clear|auto-clos/);
    expect(body).toContain('b-482');
    expect(body).toMatch(/stale/);
  });

  it('B-529: reverts to the gate INPUT for ALL THREE targets (clarify→Proposed, decompose→Clarified, design→Decomposed)', () => {
    const body = skill.body.toLowerCase();
    // clarify lands at Proposed via revising-promoting (the Phase-1 input-edge, not named after a discovery gate)
    expect(body).toMatch(/clarify.*proposed|proposed.*clarify/);
    expect(body).toMatch(/revising-promoting/);
    // decompose lands at Clarified, design lands at Decomposed (their INPUT states)
    expect(body).toMatch(/decompose.*clarified|clarified.*decompose/);
    expect(body).toMatch(/design.*decomposed|decomposed.*design/);
    // the INPUT-state principle is named, and the landing is the gate's input (NOT its output)
    expect(body).toMatch(/input[- ]state|gate'?s? input|target'?s? input/);
  });

  it('B-529: hands off to a NATIVE re-run — does NOT author the revised decision (no fold) for any target', () => {
    const body = skill.body.toLowerCase();
    // the skill hands off; the gate re-runs natively and authors the revised decision through its own surface
    expect(body).toMatch(/native.*re-?run|re-?run.*nativ/);
    expect(body).toMatch(/not? .*author|does not author|no longer.*author|never.*fold|not folded|no.*fold/);
    // it must NOT reference record_decision anymore — the revised decision is authored at the re-run gate, not here
    expect(referencedHarmonyTools(skill.body)).not.toContain('record_decision');
  });

  it('REJECT is a no-op — no state change, no supersede, no knowing-divergence record', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/no-op|no op/);
    // unlike stale-patch, reject records NO knowing-divergence.
    expect(body).toMatch(/no.*knowing-divergence|without.*knowing-divergence|not.*knowing-divergence/);
    // explicit: do not supersede / revert / park on reject.
    expect(body).toMatch(/do not supersede|do not revert|untouched/);
  });

  it('reports ready-to-re-conduct-forward after accept', () => {
    const body = skill.body.toLowerCase();
    expect(body).toMatch(/re-conduct|re-run.*forward|ready to.*conduct|drives? .*forward/);
  });

  it('B-473: guards child disposition for reverts that cross the decompose gate (two-tier)', () => {
    const tools = referencedHarmonyTools(skill.body);
    const body = skill.body.toLowerCase();
    // detection + execution substrate (get_task already required above)
    expect(tools).toContain('list_subtasks');     // read the children
    expect(tools).toContain('update_task');        // archive a child (recoverable)
    expect(tools).toContain('manage_subtasks');    // reparent a child
    // the two-tier disposition policy is spelled out
    expect(body).toMatch(/child[- ]disposition|disposition/);
    expect(body).toMatch(/archive/);
    expect(body).toMatch(/reparent/);
    expect(body).toMatch(/work-?less/);              // Tier 1
    expect(body).toMatch(/has work|work-?bearing/);  // Tier 2
    // recoverable archive, never a delete
    expect(skill.body).toContain('archived: true');
    // only crosses the gate for clarify/decompose targets (design does not)
    expect(body).toMatch(/cross.*decompose|decompose.*cross|before .{0,4}decomposed/);
  });

  it('carries the read-only discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });

  // B-762: the target-gate whitelist widens to accept `build` (a release-gate merge-conflict reopen),
  // and this skill no longer restates the target->activity->landing table — it points at gate-routing.md,
  // the new canonical home (B-762 item 1), instead of duplicating it.
  it('B-762: accepts --to build (source {Built, Deployed}), lands at Planned via revising-building', () => {
    const body = skill.body;
    const lower = body.toLowerCase();
    expect(lower).toMatch(/--to build/);
    expect(body).toContain('revising-building');
    expect(body).toMatch(/`Planned`/);
    // Source states: Built (one hop) and Deployed (two hops via the same activity twice).
    expect(body).toMatch(/\{Built, Deployed\}|`Built`.*`Deployed`|`Deployed`.*`Built`/);
    expect(lower).toMatch(/two hops|twice/);
  });

  it('B-762: --to build is never inferred — only ever an explicit target, per the release-gate merge-conflict case', () => {
    const lower = skill.body.toLowerCase();
    expect(lower).toMatch(/never.*inferred|never \*inferred\*/);
    expect(skill.body).toContain('CONFLICTING');
  });

  it('B-762: step 5 revert now goes through the shared reopenToGate procedure, not a single raw advance_workflow call, for the build target', () => {
    const body = skill.body;
    expect(body).toContain('reopenToGate');
    expect(body).toContain('skills/harmony-shared/gate-routing.md');
    expect(body.toLowerCase()).toMatch(/§reopen to a target gate/);
  });

  it('B-762: points at gate-routing.md as the canonical target->activity->landing table instead of restating it', () => {
    const body = skill.body;
    // The canonical pointer text appears (mirrors the B-762 spec's example wording).
    expect(body).toMatch(/see `skills\/harmony-shared\/gate-routing\.md` §Reopen to a target gate/);
    // The four-column table is no longer literally restated inline (build row wasn't here before B-762,
    // so its ABSENCE as a literal markdown table row is the structural signal the table was removed,
    // not merely extended in place).
    expect(body).not.toMatch(/\|\s*build\s*\|\s*`revising-building`\s*\|\s*`Planned`\s*\|/);
  });
});
