import { describe, expect, it } from 'vitest';
import { readSharedDoc, readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

// The executable product here is skill prose. Pin the load-bearing instructions at their
// shared owner and the entry points that must consult them, rather than copy routing logic.
describe('B-927 no-code completion procedure', () => {
  const routing = readSharedDoc('gate-routing');
  const procedure = routing.split('## Recognize a no-code design outcome (B-927)')[1]
    ?.split('## Human-facing vocabulary')[0] ?? '';

  it('is consulted at final design and before ordinary planning by every entry point', () => {
    expect(procedure).toContain('last required design sub-track');
    expect(procedure).toContain('Designed pickup before');
    for (const name of ['harmony-conduct', 'harmony-design-decide', 'start-work']) {
      expect(readSkill(name).body).toContain('**Recognize a no-code design outcome**');
    }
    const plan = readSkill('start-work').body;
    expect(plan.indexOf('**Before ordinary Designed planning (B-927)')).toBeLessThan(plan.indexOf('### O2. Plan'));
    const design = readSkill('harmony-design-decide').body;
    expect(design.indexOf('**Recognize no-code before final-track compose')).toBeLessThan(design.indexOf('**Decision-only completion line'));
  });

  it('requires whole-scope evidence, rejects false no-code signals and bounds recovery', () => {
    expect(procedure).toContain('whole deliverable scope');
    expect(procedure).toContain('all required tracks must be Accepted');
    expect(procedure).toMatch(/no-code recommendation alone, an empty or checked AC list/);
    expect(procedure).toContain('Mixed scope or unresolved implementation stays on the ordinary path');
    expect(procedure).toContain('Planned/Built/Deployed');
    expect(procedure).toContain('recorded build PR retain the existing revise-scope route');
    expect(procedure).toContain('Capture-only and conflicting markers never enter');
  });

  it('stamps with real guarded tools before completion and confirms the installed contract', () => {
    const tools = referencedHarmonyTools(procedure);
    const registered = new Set(registerTools().map(t => t.name));
    for (const tool of tools) expect(registered.has(tool), tool).toBe(true);
    expect(tools).toEqual(expect.arrayContaining(['list_labels', 'manage_labels']));
    expect(procedure).toContain('add: [decisionLabelId]');
    expect(procedure).toContain('can_mark_decision_only');
    expect(procedure).toContain('Re-read the ticket after stamping');
    expect(procedure).toContain("guard_available === true");
    expect(procedure).toContain('before composing');
    expect(procedure).toMatch(/capability\/eligibility refusal files an answerable worker-question/);
  });

  it('requires a fresh human completing accept and preserves agreed realization', () => {
    expect(procedure).toContain('pending_activity: null');
    expect(procedure).toContain('existing Accepted design decision');
    expect(procedure).toContain('to_state: "Verified", realization: "agreed"');
    expect(procedure).toContain('human hard floor in every mode and per-gate override');
    expect(procedure).toContain('orchestrator approval never authorize completion');
    expect(procedure).toContain('Only a fresh explicit human completing');
  });

  it('makes human send-back restart safe and removes only the marker before planning', () => {
    const back = procedure.split('### Human send-back: implementation is owed')[1] ?? '';
    expect(back).toContain('Before any\nlabel removal');
    expect(back).toContain('persist their verbatim feedback and the implementation obligation');
    expect(back).toContain('remove: [decisionLabelId]');
    expect(back).toContain('Preserve every unrelated label');
    expect(back).toMatch(/Re-read and require an\nunmarked deliverable before ordinary planning/);
    expect(back).toContain('entire frame');
    expect(back).toContain('that omits `completion`');
    expect(back).toContain('Do not omit the frame itself');
    expect(back).toContain('revising_brief_id');
    expect(back).toContain('decision_ref: null');
    expect(back).toContain('human-ratified\nrevise-scope/design revision route');
    expect(back).toContain('An already absent marker needs no second removal');
    expect(back).toContain('not a loop that re-stamps the marker');
  });

  it('recovers interruption between stamping and briefing without duplicate acceptance', () => {
    expect(procedure).toContain('Reuse a\nsuccessful stamp and an active completing brief');
    expect(procedure).toContain('never duplicate an accept or force a state');
    expect(procedure).toContain('If stamping succeeded but composition did not, compose the missing brief');
  });

  it('leaves ordinary gates and criterion settlement in place', () => {
    expect(procedure).toContain('Ordinary build tickets keep their plan, pushed PR, release and verify gates');
    expect(procedure).toContain('B-1410\ncriterion settlement');
    expect(procedure).toContain('No ordinary release exemption is introduced');
    expect(readSkill('harmony-design-decide').body).toContain('Only for a resolved decision-only ticket on the LAST required sub-track');
  });
});
