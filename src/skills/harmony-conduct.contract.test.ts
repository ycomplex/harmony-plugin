import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-conduct skill contract', () => {
  const skill = readSkill('harmony-conduct');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-conduct');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it('is scoped to the read-only conductor role (no code writes, no git mutation)', () => {
    // The conductor orchestrates plumbing; the gate skills it delegates to own the writes.
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });

  it('CONTROLLED-ONLY: pauses at every gate and never auto-advances (the core contract)', () => {
    const body = skill.body.toLowerCase();
    // It pauses and surfaces every decision.
    expect(body).toContain('pause');
    expect(body).toContain('every gate');
    // Phase 2a is explicitly NOT the autonomy/breaker/risk work.
    expect(body).toContain('--unattended');
    expect(body).toMatch(/no .*--unattended|never.*auto-advance|does not auto-advance|not auto-advance/);
    expect(body).toContain('circuit-breaker');
    expect(body).toContain('risk signal');
    // Out-of-scope phases are named so the boundary is unmistakable.
    expect(body).toContain('2a');
    expect(body).toMatch(/2b|2c|2d/);
  });

  it('NEVER resolves a brief itself — the human owns the decision at each gate', () => {
    // The conductor delegates resolution to the gate skills; it must not call resolve_brief.
    // The body explicitly states it never does so, but it must also not actually reference the tool
    // as something it calls. Assert the prohibition prose is present AND the tool is described as
    // delegated, not invoked by the conductor.
    expect(skill.body.toLowerCase()).toMatch(/never calls .*resolve_brief|does not (call|resolve)|conductor.*never.*resolve_brief|never.*resolve_brief/);
    expect(skill.body).toContain('resolve_brief'); // it references the concept (to forbid calling it)
  });

  it('is state-driven and resumable — memory lives in the ticket row, not the session', () => {
    const body = skill.body.toLowerCase();
    expect(body).toContain('resumable');
    expect(body).toMatch(/state-driven|ticket row|no state in the session|stateless between pauses/);
    // It re-reads the ticket to reconstitute, and re-running resumes.
    expect(referencedHarmonyTools(skill.body)).toContain('get_task');
    expect(skill.body).toContain('workflow_state');
    expect(skill.body).toContain('awaiting_human_input');
  });

  it('walks the full forward path by delegating to each owning gate skill in order', () => {
    // Every gate skill in the lifecycle must be a delegation target.
    for (const gate of [
      'harmony-clarify',
      'harmony-decompose',
      'harmony-design-decide',
      'start-work',
      'finish-work',
    ]) {
      expect(skill.body, `missing delegation to ${gate}`).toContain(gate);
    }
    // The forward states it routes on (the §6.1 path).
    for (const state of ['Idea', 'Clarified', 'Decomposed', 'Designed', 'Planned', 'Built', 'Released', 'Verified']) {
      expect(skill.body, `missing state ${state} in the map`).toContain(state);
    }
  });

  it('routes a Stale ticket to the patch author rather than advancing it', () => {
    expect(skill.body).toContain('harmony-stale-patch');
    expect(skill.body.toLowerCase()).toContain('stale');
  });

  it('handles the null-brief verification-ack-pending umbrella without choking (B-471)', () => {
    const body = skill.body;
    expect(body).toContain('verification-ack-pending');
    expect(body.toLowerCase()).toContain('umbrella');
    expect(body).toContain('umbrella-auto-verify');
    // The verify gate delegates to finish-work, which composes the missing brief.
    expect(body).toContain('finish-work');
  });

  it('terminates on Verified / Parked / Cancelled and pauses everywhere else', () => {
    for (const terminal of ['Verified', 'Parked', 'Cancelled']) {
      expect(skill.body).toContain(terminal);
    }
    expect(skill.body.toLowerCase()).toMatch(/terminal/);
  });
});
