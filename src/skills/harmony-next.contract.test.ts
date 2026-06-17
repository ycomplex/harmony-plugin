import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-next skill contract', () => {
  const skill = readSkill('harmony-next');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-next');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it('routes by awaiting_human_reason to the right activity skill', () => {
    expect(skill.body).toContain('awaiting_human_reason');
    expect(skill.body).toContain('resolve_brief');
    for (const r of ['clarification-draft', 'release-decision-pending', 'design-decision-draft']) {
      expect(skill.body).toContain(r);
    }
  });
  it('restricts inline accept to the pure gates and delegates the side-effecting ones (F1)', () => {
    expect(skill.body.toLowerCase()).toContain('delegate');
    expect(skill.body.toLowerCase()).toContain('pure gate');
    // Token co-occurrence isn't enough: verify the MAPPING. Split the accept section into the
    // pure-gate segment (inline resolve_brief) and the side-effecting segment (delegated), and
    // assert each reason lands on the correct side — so an inverted body (a side-effecting gate
    // listed as inline-accept) fails here, not silently at the acceptance walk.
    const pureIdx = skill.body.indexOf('Pure gates');
    const sideIdx = skill.body.indexOf('Side-effecting gates');
    expect(pureIdx).toBeGreaterThan(-1);
    expect(sideIdx).toBeGreaterThan(pureIdx);
    const pureSeg = skill.body.slice(pureIdx, sideIdx);
    const sideSeg = skill.body.slice(sideIdx);
    for (const r of ['clarification-draft', 'design-decision-draft', 'plan-draft']) {
      expect(pureSeg).toContain(r); // pure gates resolve inline
    }
    for (const r of ['decomposition-proposal', 'release-decision-pending', 'verification-ack-pending']) {
      expect(sideSeg).toContain(r); // side-effecting gates are delegated
      expect(pureSeg).not.toContain(r); // …and must NOT be in the inline-accept set
    }
  });
  it('routes a Stale ticket to the patch author (F3 — the §6.4 loop is built)', () => {
    expect(skill.body).toContain('harmony-stale-patch');
    expect(skill.body).toContain('stale-patch-review');
  });
  it('authors deferral knowledge before parking (F4 — deferral-as-knowledge)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    // graceful fallback: a defer with no rationale still parks (B-352)
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);
  });
  it('handles the null-brief verification-ack-pending umbrella by delegating to finish-work (B-471)', () => {
    const body = skill.body;
    // A verification-ack-pending item can have a null brief (trigger-surfaced PR-less umbrella).
    expect(body).toContain('verification-ack-pending');
    expect(body.toLowerCase()).toContain('umbrella');
    expect(body.toLowerCase()).toMatch(/null brief|brief.*null|get_brief.*null|null.*get_brief/);
    // It must NOT choke on the missing brief — it delegates to finish-work (verify step).
    expect(body).toContain('finish-work');
    // Tie the null-brief case to the verification reason AND the finish-work delegation, in the SAME
    // paragraph (the "Null brief …" block, bounded by the next `###` heading) — so a stray "null" or
    // "finish-work" elsewhere in the body can't satisfy this.
    const nullIdx = body.indexOf('Null brief');
    expect(nullIdx).toBeGreaterThan(-1);
    const after = body.slice(nullIdx);
    const nextHeading = after.indexOf('\n###');
    const seg = nextHeading > -1 ? after.slice(0, nextHeading) : after;
    expect(seg).toContain('verification-ack-pending');
    expect(seg).toContain('finish-work');
    expect(seg.toLowerCase()).toContain('umbrella');
    // B-471 review fold #1 (MINOR): reference the authoritative marker so the umbrella case is
    // unambiguous — the SAME purpose-built signal finish-work keys on. Scoped to the null-brief paragraph.
    expect(seg).toContain('umbrella-auto-verify');
    expect(seg).toContain('awaiting_human_ref');
  });
  it('SURFACES the promote-to-Idea triage decision on a Captured item — does NOT auto-advance (B-490 F2)', () => {
    const body = skill.body;
    // harmony-next pulls un-triaged items; promoting (Captured→Idea) is a human triage move, so it
    // surfaces the decision and stops — the OPPOSITE of harmony-conduct (which auto-advances).
    expect(body).toContain('Captured');
    expect(body).toContain('promoting');
    // Scope to the Captured-handling section so a stray token elsewhere can't satisfy it.
    const capIdx = body.indexOf("workflow_state === 'Captured'");
    expect(capIdx).toBeGreaterThan(-1);
    const after = body.slice(capIdx);
    const nextHeading = after.indexOf('\n###');
    const seg = nextHeading > -1 ? after.slice(0, nextHeading) : after;
    // It must SURFACE / not auto-advance promoting, frame it as triage, and stop (no clarify run).
    expect(seg.toLowerCase()).toMatch(/surface/);
    expect(seg.toLowerCase()).toMatch(/do not auto-advance|not auto-advance|don't auto-advance/);
    expect(seg.toLowerCase()).toMatch(/triage/);
    expect(seg.toLowerCase()).toMatch(/stop|pause|ball is in the human/);
  });
  it('is scoped to the read-only discovery role', () => {
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });
});
