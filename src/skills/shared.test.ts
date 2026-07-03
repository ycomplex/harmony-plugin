import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill, readSharedDoc, referencedHarmonyTools } from './skill-contract.js';

const SKILLS = join(process.cwd(), 'skills');

describe('skill-contract helper', () => {
  it('parses frontmatter + body of an existing skill', () => {
    const s = readSkill('start-work');
    expect(s.frontmatter.name).toBe('start-work');
    expect(s.body.length).toBeGreaterThan(100);
  });
  it('extracts referenced harmony tools from a body', () => {
    const tools = referencedHarmonyTools('call mcp__harmony__get_task then mcp__harmony__update_task');
    expect(tools).toEqual(expect.arrayContaining(['get_task', 'update_task']));
  });
  it('readSharedDoc reads a harmony-shared reference doc', () => {
    expect(readSharedDoc('knowledge-discipline').length).toBeGreaterThan(100);
  });
});

describe('shared references', () => {
  it('knowledge-discipline names all six domains', () => {
    const doc = readFileSync(join(SKILLS, 'harmony-shared/knowledge-discipline.md'), 'utf8');
    for (const d of ['engineering', 'operations', 'data', 'product', 'customer', 'process']) {
      expect(doc).toContain(d);
    }
    expect(doc.toLowerCase()).toContain('research-first');
  });
  it('role-profiles names the four agent-model §3 profiles', () => {
    const doc = readFileSync(join(SKILLS, 'harmony-shared/role-profiles.md'), 'utf8');
    for (const p of ['harmony-discovery', 'harmony-build', 'harmony-release', 'harmony-verify']) {
      expect(doc).toContain(p);
    }
  });
});

// B-545: the canonical gate routing is the single source of truth (no longer hand-copied into
// harmony-next + harmony-conduct). These assertions live HERE, at the SSoT, so the two skill
// contract tests no longer re-duplicate the routing facts.
describe('gate-routing (B-545 SSoT)', () => {
  const doc = readSharedDoc('gate-routing');

  it('records every forward + terminal workflow_state', () => {
    for (const state of [
      'Captured', 'Idea', 'Clarified', 'Decomposed', 'Designed',
      'Planned', 'Built', 'Released', 'Verified', 'Parked', 'Cancelled',
    ]) {
      expect(doc, `gate-routing.md missing state ${state}`).toContain(state);
    }
  });

  it('names every owning skill in the forward path (+ the off-path stale author)', () => {
    for (const skill of [
      'harmony-clarify', 'harmony-decompose', 'harmony-design-decide',
      'start-work', 'finish-work', 'harmony-stale-patch',
    ]) {
      expect(doc, `gate-routing.md missing owning skill ${skill}`).toContain(skill);
    }
  });

  it('marks release + verify as the hard floor (always human)', () => {
    expect(doc.toLowerCase()).toContain('hard floor');
    // The release/verify rows carry the hard-floor marking.
    expect(doc).toMatch(/release[\s\S]*always human|always human[\s\S]*release/i);
    expect(doc.toLowerCase()).toContain('verify');
  });

  it('classifies each brief reason as pure (inline) vs side-effecting (delegated)', () => {
    const lower = doc.toLowerCase();
    expect(lower).toContain('pure');
    expect(lower).toMatch(/side-effecting/);
    for (const pure of ['design-decision-draft', 'plan-draft']) {
      expect(doc, `gate-routing.md missing pure reason ${pure}`).toContain(pure);
    }
    // B-648: clarification-draft is side-effecting (accept files the happy-path ACs first).
    for (const side of ['clarification-draft', 'decomposition-proposal', 'release-decision-pending', 'verification-ack-pending']) {
      expect(doc, `gate-routing.md missing side-effecting reason ${side}`).toContain(side);
    }
  });

  it('carries the B-446 human-facing release/verify gate vocabulary', () => {
    expect(doc.toLowerCase()).toContain('release gate');
    expect(doc).toContain('B-446');
  });
});

// B-461: the discuss trigger's semantics live in ONE canonical home (elicitation-engine.md) and are
// consumed by reference everywhere else. These pins live HERE, at the SSoT (the gate-routing idiom),
// so the routing prose can't silently drift out from under its consumers (the B-648 discipline).
describe('elicitation-engine — the discuss trigger (B-461 canonical home)', () => {
  const doc = readSharedDoc('elicitation-engine');
  const lower = doc.toLowerCase();

  it('has the top-level discuss-trigger section with the trigger config (trigger/gate/brief_id)', () => {
    expect(doc).toContain('## The discuss trigger (B-461)');
    expect(doc).toMatch(/trigger:\s*'discuss'/);
    expect(doc).toContain('brief_id');
  });

  it('documents the web capture marker and that filing round 1 IS the consume (clears the marker)', () => {
    expect(doc).toMatch(/pending_resolution\s*=\s*\{\s*command:\s*'discuss'/);
    expect(lower).toMatch(/filing round 1 clears/);
    expect(lower).toMatch(/is the consume/);
    expect(lower).toMatch(/never\s+re-consumable/);
  });

  it('states the resolution-suspension predicate (pending discuss marker OR active attached exchange), on both surfaces', () => {
    expect(doc).toContain('SUSPENDED');
    expect(lower).toMatch(/pending discuss marker/);
    expect(lower).toMatch(/active attached exchange/);
    expect(lower).toMatch(/both\s+surfaces/);
  });

  it('names the TWO escapes — force-quit (redraft with what you have) and cancel (untouched brief: no redraft, no claims, no iteration bump)', () => {
    expect(lower).toMatch(/force-quit/);
    expect(lower).toMatch(/redraft with what you have/);
    expect(lower).toMatch(/never mind/);
    expect(doc).toMatch(/conclude(_elicitation)?\(?'abandoned'\)?/);
    expect(lower).toMatch(/untouched brief/);
    expect(lower).toMatch(/no redraft/);
    expect(lower).toMatch(/no claims/);
    expect(lower).toMatch(/no iteration bump/);
  });

  it('conclude → re-compose ONCE: in-place iterate, iteration+1, coupled claims, "What I learned from you"', () => {
    expect(lower).toMatch(/re-compose the brief\s+\*?\*?once/);
    expect(doc).toMatch(/iteration\s*\+\s*1|iteration\+1|`iteration\+1`/);
    expect(doc).toContain('underwriting_brief_id');
    expect(doc).toContain('What I learned from you');
  });

  it("pins the claims-hygiene rule: on the typed 'exchange-cancelled' no-op the agent ARCHIVES the claims it minted that turn", () => {
    expect(doc).toContain('exchange-cancelled');
    expect(lower).toMatch(/archives?\b/);
    expect(lower).toMatch(/never promote/);
  });

  it('distinguishes system-abandon (gate re-entry re-surfaces) from a human cancel (immediate mechanical restore)', () => {
    expect(lower).toMatch(/system-abandon/);
    expect(lower).toMatch(/human cancel/);
    expect(lower).toMatch(/re-entry/);
    expect(lower).toMatch(/mechanical/);
  });
});

// B-461: the five brief-verb surfaces consume the canonical home BY REFERENCE — one identical
// single-line pointer each, no restated semantics (harmony-conduct carries its own richer routing
// prose, pinned in its contract test).
describe('discuss verb pointers (B-461 — the five verb surfaces reference the canonical home)', () => {
  const POINTER =
    /\*\*discuss <remark>\*\* → open a discussion on this brief per `skills\/harmony-shared\/elicitation-engine\.md` §The discuss trigger \(resolution suspends until it concludes\)\./;

  for (const name of ['harmony-clarify', 'harmony-decompose', 'harmony-design-decide', 'start-work', 'finish-work']) {
    it(`${name} carries the one-line discuss pointer`, () => {
      expect(readSkill(name).body, `${name} missing the B-461 discuss pointer`).toMatch(POINTER);
    });
  }
});
