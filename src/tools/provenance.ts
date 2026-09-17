// B-1021: shared provenance vocabulary + the knowledge-write provenance fence.
//
// This module exists SEPARATELY from briefs.ts (rather than knowledge.ts importing the constants
// from there) because briefs.ts already imports from knowledge.ts (queryKnowledge, getWorkspaceId) —
// the reverse import would create a circular module dependency. briefs.ts re-exports the three
// original B-734 constants from here unchanged (values/behavior untouched); knowledge.ts imports
// `guardKnowledgeWriteProvenance` directly.

/** The human explicitly decided within a running plugin/CLI session. */
export const PROVENANCE_HUMAN_IN_SESSION = 'human-in-session';
/** The conductor synthesized/auto-advanced the decision under a delegation mode (optionally `:<mode>`). */
export const PROVENANCE_AGENT_SYNTHESIZED = 'agent-synthesized';
/** harmony-web's own value — a browser click. The plugin is never the browser and must never send it. */
export const PROVENANCE_WEB_ONLY = 'human-in-browser';

// ——— B-1021: agent-on-behalf — an agent's hand, a human's already-made decision ——————————————————
//
// Distinct from `agent-synthesized[:<mode>]` (the CONDUCTOR decided/auto-advanced — no human in the
// loop for that specific call): `agent-on-behalf:<human-provenance>` means a HUMAN already decided
// and the leg executing this particular write is only carrying that decision through — e.g.
// finish-work's O2 convention-entry writer, authored by the skill AFTER the release accept a human
// already made. Conflating the two would misattribute a human's decision to conductor synthesis, or
// vice versa — both are reader-visible lies about who decided.
//
// The suffix is a CLOSED set of exactly two values — the only two provenances a human's own decision
// can have been recorded under (see PROVENANCE_HUMAN_IN_SESSION / PROVENANCE_WEB_ONLY above). No other
// suffix is valid; a near-miss must be rejected rather than silently stored (same rationale as
// `validateResolutionProvenance`'s own near-miss rejection in briefs.ts).
export const PROVENANCE_AGENT_ON_BEHALF = 'agent-on-behalf';
export const PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_SESSION = `${PROVENANCE_AGENT_ON_BEHALF}:${PROVENANCE_HUMAN_IN_SESSION}`;
export const PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_BROWSER = `${PROVENANCE_AGENT_ON_BEHALF}:${PROVENANCE_WEB_ONLY}`;

const AGENT_ON_BEHALF_CLOSED_SUFFIXES: readonly string[] = [PROVENANCE_HUMAN_IN_SESSION, PROVENANCE_WEB_ONLY];

/**
 * Fence a knowledge-write RPC's `provenance` param (B-1021 — the write side of the seven-row bug where
 * a conductor leg stamped its own knowledge writes with the web-client-only `human-in-browser`).
 *
 * Call this BEFORE the RPC on every knowledge_* write that takes a provenance param — it throws
 * (fail-closed) rather than letting a bad value reach the network call:
 *   - null/undefined PASS — a knowledge write with no provenance is fine; this does not newly require one.
 *   - bare `human-in-browser` is REJECTED — the plugin is never the browser, and accepting it here
 *     would let an agent claim a human clicked.
 *   - an `agent-on-behalf:`-prefixed value is validated against the closed pair of suffixes; any other
 *     suffix is REJECTED.
 *   - everything else (free-form tags, `agent-synthesized[:<mode>]`, etc.) PASSES THROUGH unchanged —
 *     this guard closes exactly the two gaps above, it does not re-validate the whole vocabulary
 *     knowledge writes already accept.
 */
export function guardKnowledgeWriteProvenance(provenance: string | null | undefined): void {
  if (provenance === null || provenance === undefined) return;

  if (provenance === PROVENANCE_WEB_ONLY) {
    throw new Error(
      `provenance '${PROVENANCE_WEB_ONLY}' is the web client's alone — the plugin is never the browser, ` +
      `and accepting it here would let an agent claim a human clicked. Use '${PROVENANCE_HUMAN_IN_SESSION}' ` +
      `when the human decided in this session, or '${PROVENANCE_AGENT_ON_BEHALF}:<human-provenance>' when ` +
      `an agent is writing on a human's already-made decision (accepted: ` +
      `'${PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_SESSION}' or '${PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_BROWSER}').`,
    );
  }

  if (provenance.startsWith(`${PROVENANCE_AGENT_ON_BEHALF}:`)) {
    const suffix = provenance.slice(PROVENANCE_AGENT_ON_BEHALF.length + 1);
    if (AGENT_ON_BEHALF_CLOSED_SUFFIXES.includes(suffix)) return;
    throw new Error(
      `invalid provenance '${provenance}' — '${PROVENANCE_AGENT_ON_BEHALF}:' accepts only ` +
      `'${PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_SESSION}' or '${PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_BROWSER}', ` +
      `never any other suffix — an unrecognised suffix would render as an unattributed/unrecognised tag forever.`,
    );
  }
}
