// B-911 — start_elicitation's OWN description is the one place an agent reads to learn the valid
// `trigger` vocabulary (the DB column is free text — src/tools/elicitation.ts's VALID_TRIGGERS is the
// runtime allowlist, not documentation). The tool's docs lagged the already-Accepted B-733
// 'worker-question' trigger (harmony-conduct + start-work both prescribe it) — this is the no-drift
// proof, in the same style as stop-gate.contract.test.ts: bind every trigger value the SHIPPED SKILLS
// actually prescribe to the tool's own documented vocabulary, so a skill that starts citing a new
// trigger and the tool's description can never silently drift apart again.

import { describe, it, expect } from 'vitest';
import { startElicitationTool } from './elicitation.js';
import { readSkill, readSharedDoc } from '../skills/skill-contract.js';

/** Every `trigger: '<value>'` / `trigger:"<value>"` literal prescribed in a skill/shared-doc body. */
function extractTriggerLiterals(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(/trigger:\s*['"]([a-z-]+)['"]/g)) set.add(m[1]);
  return [...set];
}

describe("start_elicitation's documented trigger vocabulary (B-911 no-drift)", () => {
  // harmony-conduct names the worker-question trigger in prose (§4e) and points at the shared
  // elicitation-engine.md doc for the mechanics; start-work carries the literal code-call form. Both
  // are read here so either shape of "the skill prescribes it" is caught.
  const conduct = readSkill('harmony-conduct');
  const startWork = readSkill('start-work');
  const engine = readSharedDoc('elicitation-engine');

  const prescribed = new Set([
    ...extractTriggerLiterals(conduct.body),
    ...extractTriggerLiterals(startWork.body),
    ...extractTriggerLiterals(engine),
  ]);

  it('the skills actually prescribe at least one trigger literal (a non-vacuous check)', () => {
    expect(prescribed.size).toBeGreaterThan(0);
  });

  it("prescribe 'worker-question' — the already-Accepted B-733 trigger this ticket catches the tool's docs up to", () => {
    expect(prescribed.has('worker-question')).toBe(true);
    // harmony-conduct §4e explicitly names it as the running session's own escape hatch for a
    // judgment call or capability denial — pin that framing so a rewrite can't silently drop it.
    expect(conduct.body).toContain('worker-question');
    expect(conduct.body.toLowerCase()).toMatch(/judgment call|capability denial/);
  });

  it("start_elicitation's own trigger description names every skill-prescribed trigger value", () => {
    const triggerProp = (
      startElicitationTool.inputSchema.properties as Record<string, { description: string }>
    ).trigger;
    for (const trigger of prescribed) {
      expect(
        triggerProp.description,
        `start_elicitation's trigger description is missing '${trigger}' — a skill prescribes it but the tool's own docs don't name it`,
      ).toContain(`'${trigger}'`);
    }
  });
});
