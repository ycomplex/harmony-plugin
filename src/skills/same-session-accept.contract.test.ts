import { describe, it, expect } from 'vitest';
import { readSkill, readSharedDoc } from './skill-contract.js';

// B-1029 — closed-set assertion for the same-session accept fix: the commit-only
// `consume_acceptance_event` was being called where the payload-applying
// `consume_pending_acceptance_event` was needed, silently dropping B-866/B-867's `gate_slot` /
// `knowledge_entry_content` payload items. See `src/tools/acceptance-events.ts`'s module doc-comment
// and each swapped skill's own B-1029 note for the mechanism.
//
// DELIBERATELY GENERIC — no literal line-number pins (those drift the moment a skill's prose is
// re-flowed). Every assertion below matches on the ACTUAL tool-call text
// (`mcp__harmony__<tool>(`), never on surrounding prose that merely MENTIONS a tool by name — a
// skill's discussion of "why NOT to call X here" would otherwise be misread as a call site.

/** Count real MCP tool CALLS (`mcp__harmony__<tool>(`), not prose mentions of the tool's name without
 *  a trailing paren (e.g. "`consume_pending_acceptance_event`'s echoed `items` field"). */
function countCalls(body: string, toolName: string): number {
  const re = new RegExp(`mcp__harmony__${toolName}\\(`, 'g');
  return (body.match(re) ?? []).length;
}

describe('same-session accept: consume_pending_acceptance_event is the same-session tool (B-1029)', () => {
  // The four gate skills whose same-session accept path materializes its own writes and must ALSO run
  // the payload-apply step (via consume_pending_acceptance_event) rather than commit-only. Each of
  // these calls it at least once for its PRIMARY accept; harmony-clarify and start-work call it a
  // second time for a secondary branch/self-heal probe — see each skill's own inline B-1029 note for
  // which call is which. The generic floor asserted here is simply: "at least one real call exists" —
  // never a specific count tied to a specific line.
  const gateSkills = ['harmony-clarify', 'harmony-decompose', 'harmony-design-decide', 'start-work'];

  it.each(gateSkills)('%s calls consume_pending_acceptance_event for its same-session accept', (name) => {
    const skill = readSkill(name);
    expect(
      countCalls(skill.body, 'consume_pending_acceptance_event'),
      `${name}/SKILL.md has no real consume_pending_acceptance_event(...) call — the same-session accept must apply the deferred payload, not just commit it`,
    ).toBeGreaterThan(0);
  });

  // THE CLOSED SET. Every OTHER same-session-ADJACENT caller of the commit-only consume_acceptance_event
  // is a NARROW, JUSTIFIED exception — not a missed swap. Asserted as an exact per-file call count, not
  // a blanket "zero everywhere else" check, so a genuinely new exception must be added here deliberately
  // rather than silently widening this set.
  //
  //   - harmony-clarify: TWO continuations that run strictly AFTER consume_pending_acceptance_event has
  //     already applied this event's gate_slot/knowledge_entry_content items (B-1029's label_add-last
  //     reorder) — the decision-only guard-blocked branch and the label-RPC-not-yet-deployed branch.
  //     Re-running the full apply again would just retry the same doomed label_add write.
  //   - harmony-conduct: ONE call, §1c's `payload-unrecognized` route — reached only once the owning
  //     gate's OWN materialization has confirmed the work is done, mirroring the same "apply already
  //     ran or was manually redone; only the commit is left" shape.
  //   - start-work: ONE call, O3's leg-start-standalone self-heal (`payload-unrecognized` route) — the
  //     documented case where start-work runs with no conductor loop wrapping it, so this branch IS
  //     start-work's own equivalent of harmony-conduct's §1c: it manually re-materializes the missed
  //     checklist/gate_slot items from the echoed payload, and only the commit is left. (Not enumerated
  //     alongside clarify/conduct in this ticket's own build brief — flagged as a closed-set entry here
  //     because it is the same justified shape and the test must match the actual code, not undercount
  //     it and fail.)
  const closedSet: Record<string, number> = {
    'harmony-clarify': 2,
    'harmony-conduct': 1,
    'start-work': 1,
    'harmony-decompose': 0,
    'harmony-design-decide': 0,
  };

  it.each(Object.entries(closedSet))('%s has exactly %i real consume_acceptance_event(...) call(s)', (name, expected) => {
    const skill = readSkill(name);
    expect(countCalls(skill.body, 'consume_acceptance_event')).toBe(expected);
  });

  it('the two shared docs name consume_pending_acceptance_event as the same-session tool', () => {
    const gateRouting = readSharedDoc('gate-routing');
    const acPickup = readSharedDoc('ac-pickup-points');

    // Both docs must describe the SAME-SESSION branch using the payload-applying tool.
    expect(gateRouting).toMatch(/\*\*Same session\*\*[\s\S]{0,400}consume_pending_acceptance_event/);
    expect(acPickup).toContain('consume_pending_acceptance_event');

    // Neither doc's same-session description should still point at the commit-only tool as THE
    // same-session mechanism (a bare mention elsewhere, e.g. naming the two justified exceptions, is
    // fine — only the primary same-session characterization is being pinned here).
    expect(gateRouting).not.toMatch(/\*\*Same session\*\*[\s\S]{0,400}calls `consume_acceptance_event\(/);
  });

  it('gate-routing.md no longer restricts the B-797/B-904 defer to the product design track only', () => {
    const gateRouting = readSharedDoc('gate-routing');
    // The corrected claim: every design sub-track defers via the event (B-904), not product-only.
    expect(gateRouting).toMatch(/every design sub-track/i);
    expect(gateRouting).toContain('B-904');
  });
});
