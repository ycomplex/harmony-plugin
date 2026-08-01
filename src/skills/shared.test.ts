import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill, readSharedDoc, referencedHarmonyTools } from './skill-contract.js';
import { VALID_TRIGGERS } from '../tools/elicitation.js';

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
      'Captured', 'Proposed', 'Clarified', 'Decomposed', 'Designed',
      'Planned', 'Built', 'Deployed', 'Verified', 'Parked', 'Cancelled',
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

// B-733: a worker with a mid-run question files a `worker-question` elicitation round instead of
// dying silently. The harmony-build hand-off relies entirely on a literal string match between the
// container agent's prompt and start-work's parser — pin both sides so they can't drift apart (the
// same prose-drift guard pattern B-732 established for the release-approval line).
describe('worker-question contract (B-733)', () => {
  it('elicitation-engine.md documents the worker-question trigger + backstop invariant', () => {
    const doc = readSharedDoc('elicitation-engine');
    const lower = doc.toLowerCase();
    expect(doc).toContain('## The worker-question trigger (B-733)');
    expect(doc).toMatch(/trigger:\s*'worker-question'/);
    expect(lower).toMatch(/capability denial/);
    expect(lower).toMatch(/backstop invariant/);
    expect(lower).toMatch(/involuntary termination/);
  });

  it('elicitation-engine.md documents the file-then-recompose ordering for a partially-applicable staged resolution', () => {
    const doc = readSharedDoc('elicitation-engine');
    expect(doc).toContain('## Resuming onto a staged pending_resolution you can only partially apply (B-733)');
    expect(doc.toLowerCase()).toMatch(/crash-safety/);
    expect(doc.toLowerCase()).toMatch(/blocked residue/);
  });

  it('harmony-conduct carries the §4e worker-question filing subsection', () => {
    const body = readSkill('harmony-conduct').body;
    expect(body).toMatch(/### 4e\. Filing a worker-question/);
    expect(body.toLowerCase()).toMatch(/clean pause, not a park/);
  });

  it('the WORKER-QUESTION marker is the IDENTICAL literal string in harmony-build.md and start-work.md (bidirectional pin)', () => {
    const buildAgentDoc = readFileSync(join(process.cwd(), 'container/agents/harmony-build.md'), 'utf8');
    const startWorkDoc = readSkill('start-work').body;
    const MARKER = 'WORKER-QUESTION:';
    expect(buildAgentDoc, 'container/agents/harmony-build.md missing the WORKER-QUESTION: marker').toContain(MARKER);
    expect(startWorkDoc, 'start-work SKILL.md missing the WORKER-QUESTION: marker it must parse').toContain(MARKER);
  });

  it('start-work parses the marker before treating the build subagent report as complete/failed', () => {
    const body = readSkill('start-work').body;
    expect(body.toLowerCase()).toMatch(/parses? .*harmony-build.*final report|final report for a `worker-question`/);
    expect(body).toContain("trigger: 'worker-question'");
  });

  it('names the harmony-build hand-off: no MCP tools, reports upward via the marker', () => {
    const buildAgentDoc = readFileSync(join(process.cwd(), 'container/agents/harmony-build.md'), 'utf8');
    expect(buildAgentDoc.toLowerCase()).toMatch(/no mcp tools/);
  });

  it('every trigger value named in skills/ prose is a member of VALID_TRIGGERS (closes the prose-to-prose blind spot)', () => {
    // PR #129 pinned `trigger: 'worker-question'` prose against OTHER prose (a bidirectional
    // literal-string contract test) but never against the real runtime enum in
    // src/tools/elicitation.ts — so the validator kept rejecting the trigger the docs promised
    // worked. Walk every .md file under skills/ (recursively — the trigger is referenced both in
    // SKILL.md files and in harmony-shared/*.md reference docs) and assert every literal
    // `trigger: '<value>'` found in prose is actually accepted by the live VALID_TRIGGERS array —
    // not a hardcoded copy of it, which is exactly how the original bug happened.
    const mdFiles = readdirSync(SKILLS, { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.md'));

    const found = new Set<string>();
    for (const rel of mdFiles) {
      const text = readFileSync(join(SKILLS, rel), 'utf8');
      for (const m of text.matchAll(/trigger:\s*'([a-z-]+)'/g)) {
        found.add(m[1]);
      }
    }

    expect(found.size, 'expected to find at least one trigger: \'...\' reference in skills/ prose').toBeGreaterThan(0);
    for (const trigger of found) {
      expect(VALID_TRIGGERS, `trigger '${trigger}' is referenced in skills/ prose but missing from VALID_TRIGGERS`).toContain(trigger);
    }
  });
});

describe('worker-question pointers — the five resume-onto-own-brief surfaces (B-733)', () => {
  const POINTER =
    /A staged `pending_resolution` you can only partially apply.*§Resuming onto a staged pending_resolution you can only partially apply/s;

  for (const name of ['harmony-clarify', 'harmony-decompose', 'harmony-design-decide', 'start-work', 'finish-work']) {
    it(`${name} carries the B-733 partial-apply pointer`, () => {
      expect(readSkill(name).body, `${name} missing the B-733 partial-apply pointer`).toMatch(POINTER);
    });
  }
});
