import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-visual-handoff skill contract', () => {
  const skill = readSkill('harmony-visual-handoff');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-visual-handoff');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('files the framed ux-ui decision through the gate machinery', () => {
    const tools = referencedHarmonyTools(skill.body);
    for (const t of ['query_knowledge', 'record_decision', 'reference_knowledge', 'compose_brief', 'resolve_brief']) {
      expect(tools, `missing ${t}`).toContain(t);
    }
  });
  it('points at the shared discipline + the surface template', () => {
    expect(skill.body).toContain('harmony-shared/visual-handoff.md');
    expect(skill.body).toContain('templates/visual-surface.html');
  });
  it('guards the locked advance rule + P3 one-brief serialization (F2 — mirrors P4 design-decide)', () => {
    // visual-handoff now OWNS the ux-ui completion accounting, so it must pin the same behaviour P4's
    // design-decide test pins — else a later edit can drop the derivation and the suite stays green while
    // the ticket silently mis-advances (or a ux-ui compose_brief silently overwrites an active sibling brief).
    expect(referencedHarmonyTools(skill.body)).toContain('list_ticket_knowledge');
    expect(skill.body.toLowerCase()).toMatch(/last\s+required\s+sub-track/);
    expect(skill.body.toLowerCase()).toMatch(/one\s+active\s+brief/);
    expect(skill.body.toLowerCase()).toContain('serialized');
  });
  it('enumerates provenance in the captured decision, not just the legend (F3)', () => {
    expect(skill.body.toLowerCase()).toMatch(/enumerate/);
  });
  it('authors deferral knowledge on the defer path (G2 — deferral-as-knowledge, mirrors P4 gate skills)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (F4/B-352)
  });
  it('encodes the B-328 disciplines (route / elicit / framed-decision / residue)', () => {
    expect(skill.body).toMatch(/glanceable\s+in\s+a\s+rendered\s+frame/i);  // D1 routing diagnostic
    expect(skill.body.toLowerCase()).toContain('elicit');                   // D2 elicit-don't-guess
    expect(skill.body).toMatch(/describe\s+the\s+alternative/i);
    expect(skill.body).toMatch(/framed\s+decision/i);                       // capture-back binding
    expect(skill.body).toMatch(/Figma/);                                    // residue pass-through
  });
  it('is Write-capable but tmp-scoped and never commits (role profile)', () => {
    expect(skill.frontmatter['allowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Edit/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git push/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git merge/);     // N2: assert the merge backstop too, not just commit/push
    expect(skill.body).toContain('/tmp/harmony-visual');                    // surface written to tmp only
    // N1: require BOTH guards (was /never\s+.*repo source|throwaway/ — either arm alone kept this green)
    expect(skill.body.toLowerCase()).toMatch(/never\s+write\s+repo\s+source/);
    expect(skill.body.toLowerCase()).toContain('throwaway');
  });
});
