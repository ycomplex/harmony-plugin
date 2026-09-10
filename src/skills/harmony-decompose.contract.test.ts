import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-decompose skill contract', () => {
  const skill = readSkill('harmony-decompose');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-decompose');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('creates children and advances via the substrate', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('manage_subtasks');
    expect(tools).toContain('compose_brief');
    expect(tools).toContain('resolve_brief');
    expect(tools).toContain('advance_workflow');
    expect(skill.body).toContain('decomposition-proposal');
  });
  it('promotes new children with `proposing` only — no off-by-one `capturing` step (B-465)', () => {
    // manage_subtasks add_new lands children at Captured (the tasks_default_workflow_state
    // insert trigger), so the only valid promotion edge is Captured->Proposed ('proposing').
    // A 'capturing' step (valid only NULL->Captured) would be rejected by the transition
    // guard. Guard against re-introducing the off-by-one (the skill was broken as written).
    expect(skill.body).not.toContain('activity: "capturing"');
    expect(skill.body).toContain('activity: "proposing"');
  });
  it('handles the explicit "no decomposition needed" decision', () => {
    expect(skill.body.toLowerCase()).toContain('no decomposition');
  });
  it('encodes the knowledge-query discipline', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
  });
  it('authors deferral knowledge on the defer path (F4 — deferral-as-knowledge)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (B-352)
  });
  it('carries the discovery role profile', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
  it('detects pre-existing children before proposing (B-646)', () => {
    // Manual pre-decomposition is common (children filed during triage); an unguided run
    // would draft a fresh competing hierarchy and duplicate them (B-550: 4 -> 8).
    expect(referencedHarmonyTools(skill.body)).toContain('list_subtasks');
    expect(skill.body).toMatch(/already decomposed|children already exist/i);
    expect(skill.body).toContain('non-archived');
  });
  it('never duplicates an existing child hierarchy (B-646)', () => {
    // The accept path must branch: confirm existing children (recommendation "confirm",
    // never "create"), add_new ONLY for genuinely net-new children.
    expect(skill.body).toMatch(/never\s+`?add_new`?\s+a fresh set that duplicates existing\s+non-archived children/i);
    expect(skill.body).toContain('net-new');
    expect(skill.body).toContain('recommendation: "confirm"');
  });
  it('never mints a per-ticket "no split" specification entry (B-849 regression guard)', () => {
    // The exact literal string the old per-ticket entry used — 264 near-identical entries were
    // retired for this; its return in a future edit would mean the regression came back.
    expect(skill.body).not.toContain('title: "<ticket>: decomposition — no split"');
  });
  it('queries the shared no-split convention entry by its stable tag (B-849)', () => {
    expect(skill.body).toContain('decompose-no-split');
    expect(referencedHarmonyTools(skill.body)).toContain('query_knowledge');
    // the tag appears specifically alongside the convention lookup, not just anywhere:
    expect(skill.body).toMatch(/type: "convention", tags: \["decompose-no-split"\]/);
  });
  it('names the no-split amend rule\'s three states, with the no-op default exercised when nothing new (B-849)', () => {
    expect(skill.body.toLowerCase()).toContain('no-op');
    expect(skill.body.toLowerCase()).toContain('already covered');
    expect(skill.body).toMatch(/never\s+`?supersede_decision`?/i);
    expect(referencedHarmonyTools(skill.body)).toContain('update_knowledge_entry');
  });
  it('records the split rationale once per accept, attached to the parent, and names it in the compose call\'s decision_ref (B-849)', () => {
    // record_decision is already referenced on the no-split-convention/deferral paths; assert the
    // split branch specifically also drives it, via a distinguishing string from the split's own
    // title template.
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('decomposition — split into');
    expect(skill.body).toMatch(/decision_ref: \{ type: "specification", id: split\.id \}/);
  });
});
