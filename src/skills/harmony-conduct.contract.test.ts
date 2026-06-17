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

  it('CONTROLLED DEFAULT: the no-flag run pauses at every gate (the core contract, intact in 2b)', () => {
    const body = skill.body.toLowerCase();
    // The default (no flag) route pauses and surfaces every decision — unchanged from phase 2a.
    expect(body).toContain('pause');
    expect(body).toContain('every gate');
    // With no flag the skill does not auto-advance — phase 2b is strictly additive over the 2a default.
    expect(body).toMatch(/no .*--unattended|never.*auto-advance|does not\b.*auto-advance|not auto-advance/);
    // The controlled-default guarantee is stated explicitly.
    expect(body).toMatch(/controlled default|default.*controlled|behaviou?rally identical to phase 2a|identical.*to phase 2a/);
    // The phase boundary is still named so the lineage (2a core) and the later phases are unmistakable.
    expect(body).toContain('2a');
    expect(body).toMatch(/2b|2c|2d/);
    // The later autonomy/breaker/risk work is still scoped OUT of this phase.
    expect(body).toContain('circuit-breaker');
    expect(body).toContain('risk signal');
  });

  it('PHASE-2B SELECTOR: opt-in per-run delegation via --pause-at / --unattended, never the system\'s call', () => {
    const body = skill.body.toLowerCase();
    // The two opt-in delegation flags exist.
    expect(body).toContain('--unattended');
    expect(body).toContain('--pause-at');
    // Delegation is opt-in per run — it is the human's conscious choice, never the conductor's inference.
    expect(body).toMatch(/opt-in per run|opt-in per-run|per-run delegation|human pass(ed|es) an explicit flag|conscious per-run choice/);
    // An auto-advanced gate synthesizes the human's accept and records the SAME decision a controlled run would.
    expect(body).toMatch(/synthesi[sz]e.*accept|auto-advance/);
    expect(body).toMatch(/same accepted|records? the same|identical to a human accept|parity/);
    // Bad input is an ERROR, never a silent delegation (the contract-1 guard).
    expect(body).toMatch(/mutually exclusive/);
    expect(body).toMatch(/unknown.*gate|misspelled.*gate|error.*never a silent|never a silent delegation/);
  });

  it('HARD FLOOR: release + verify are never auto-advanced, even unattended', () => {
    const body = skill.body;
    expect(body.toLowerCase()).toContain('hard floor');
    // Release and verify always require a human regardless of any flag.
    expect(body.toLowerCase()).toMatch(/release.*verify.*(never|always human|stay human|hard floor)|never auto-resolved/);
    expect(body.toLowerCase()).toMatch(/even .*--unattended|even unattended|always.*human/);
  });

  it('DIAL CEILING: a cautious workspace dial is a kill-switch that forbids all delegation (announced)', () => {
    const body = skill.body.toLowerCase();
    // The conductor reads the resolved workspace agent-trust dial via get_project.
    expect(referencedHarmonyTools(skill.body)).toContain('get_project');
    expect(body).toContain('agent_trust');
    // Cautious = kill-switch: forbids all delegation, run goes controlled, and it is ANNOUNCED (no silent no-op).
    expect(body).toContain('cautious');
    expect(body).toMatch(/kill-switch|forbids? all delegation|forbid.*delegation/);
    expect(body).toMatch(/announce|never silently|never a silent/);
    // The dial can only restrict (it is a ceiling), never expand the per-run flag.
    expect(body).toMatch(/ceiling|restrict-only|only restrict|never.*expand/);
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

  it('auto-advances promoting on a Captured ticket — plumbing, not a pause (B-490 F2)', () => {
    const body = skill.body;
    // Captured must be handled (it is the inbox state freshly-created tickets land in).
    expect(body).toContain('Captured');
    // The conductor advances promoting itself via advance_workflow — it does NOT compose a brief / pause.
    expect(referencedHarmonyTools(body)).toContain('advance_workflow');
    expect(body).toContain('promoting');
    // Scope the assertion to the Captured-handling step so a stray token elsewhere can't satisfy it:
    // the SAME paragraph must tie Captured → promoting → advance_workflow and frame it as no-pause plumbing.
    const capIdx = body.indexOf("workflow_state === 'Captured'");
    expect(capIdx).toBeGreaterThan(-1);
    const seg = body.slice(capIdx, capIdx + 900);
    expect(seg).toContain('promoting');
    expect(seg).toContain('advance_workflow');
    expect(seg.toLowerCase()).toMatch(/no .*pause|not a pause|plumbing/);
    // It must NOT try to file a clarifying brief from Captured (the transition-table gap that broke B-487).
    expect(seg).toContain('clarifying');
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

  it('renders the progress overview INLINE — no TodoWrite dependency (F1)', () => {
    // F1: inline rendering is the design. TodoWrite is NOT an allowed tool — the conduct session
    // doesn't reliably have it, and the overview is a read-only derived view that needs no task-list tool.
    expect(skill.frontmatter['allowed-tools']).not.toMatch(/\bTodoWrite\b/);
    // The body must specify inline rendering as the design.
    expect(skill.body.toLowerCase()).toMatch(/render.*inline|inline.*render|print the checklist inline|inline is the design/);
    expect(skill.body.toLowerCase()).toContain('inline');
  });

  it('the progress overview is a DERIVED VIEW from the ticket row, not session-held state', () => {
    const body = skill.body.toLowerCase();
    // It must be explicitly derived/regenerated from the ticket row, and explicitly NOT session state.
    expect(body).toMatch(/derived view|derive(d)? .*from the ticket row|regenerate.*from .*workflow_state/);
    expect(body).toMatch(/not session.?held state|never session state|not.*session-held/);
    // Regeneration each iteration is the mechanism that keeps it resumable / non-drifting.
    expect(body).toMatch(/regenerate|regenerated/);
    expect(body).toContain('workflow_state');
    // A fresh re-run must reconstruct it identically from the ticket — no carried session memory.
    expect(body).toMatch(/identical|fresh re-?run/);
  });

  it('the progress overview renders the fixed forward path as the checklist', () => {
    const body = skill.body.toLowerCase();
    for (const phase of ['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'verify']) {
      expect(body, `progress checklist missing phase ${phase}`).toContain(phase);
    }
    // Each item's status is derived from the current state: before = completed, current = in-progress,
    // later = pending.
    expect(body).toMatch(/in_progress|in-progress/);
    expect(body).toMatch(/completed/);
    expect(body).toMatch(/pending/);
  });

  it('the progress overview is rendered at the top of every loop iteration (after the re-read)', () => {
    const body = skill.body.toLowerCase();
    // It is tied to the get_task re-read at the top of the loop, on every iteration.
    expect(body).toMatch(/every iteration|each iteration/);
    expect(body).toMatch(/after the .*get_task|after the .*re-read|right after the .*re-read/);
  });
});
