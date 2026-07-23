// B-503: the floor-veto — the SINGLE source of truth for FLOORED brief reasons.
//
// An accept-with-remark can carry a run-scoped downstream instruction (e.g. "auto-accept decompose
// if the proposal is no-split"). Such an instruction is honored ONLY through the conductor's
// delegation test — and this helper is the mechanical backstop under that test: the hard-floor
// gates (release, verify), a stale-patch review, and a decision-only ticket's deliverable gate
// (its release+verify collapsed into one, B-681) can NEVER be pre-accepted by a remark. When the
// veto fires the conductor surfaces the gate and pauses instead of honoring the instruction.
//
// Deliberately dependency-free (no supabase, no sibling imports) so the poll code, the conductor,
// and any future caller can consume it without dragging in a client.

/** The brief reasons whose gates a remark-derived instruction can never pre-accept.
 *  release-decision-pending / verification-ack-pending are the hard floor (conduct contract 3);
 *  stale-patch-review is a reconciliation of superseded knowledge — always a human read. */
export const FLOORED_BRIEF_REASONS = [
  'release-decision-pending',
  'verification-ack-pending',
  'stale-patch-review',
] as const;

export type FlooredBriefReason = (typeof FLOORED_BRIEF_REASONS)[number];

export interface FloorVetoInput {
  /** The target brief's gate reason (briefs.reason / awaiting_human_reason). */
  reason?: string | null;
  /** true when the target brief is the deliverable gate of a `decision-only` ticket — that gate is
   *  its release+verify collapsed into one (B-681), so it inherits the hard floor. */
  decisionOnlyDeliverable?: boolean;
}

export interface FloorVetoResult {
  vetoed: boolean;
  /** When vetoed: a rationale naming the floor, for the surfaced pause. null when not vetoed. */
  why: string | null;
}

const FLOOR_RATIONALES: Record<FlooredBriefReason, string> = {
  'release-decision-pending':
    'release-decision-pending is the RELEASE hard floor — a remark can never pre-accept a release; surface the gate and pause.',
  'verification-ack-pending':
    'verification-ack-pending is the VERIFY hard floor — a remark can never pre-accept a verification ack; surface the gate and pause.',
  'stale-patch-review':
    'stale-patch-review is floored — reconciling superseded knowledge is always a human read; a remark can never pre-accept a stale patch.',
};

/** Is a remark-derived instruction targeting this brief vetoed by the floor? */
export function floorVeto(input: FloorVetoInput): FloorVetoResult {
  const reason = input.reason ?? null;
  if (reason !== null && (FLOORED_BRIEF_REASONS as readonly string[]).includes(reason)) {
    return { vetoed: true, why: FLOOR_RATIONALES[reason as FlooredBriefReason] };
  }
  if (input.decisionOnlyDeliverable === true) {
    return {
      vetoed: true,
      why:
        "a decision-only ticket's deliverable gate is its release+verify collapsed into one (B-681) — it inherits the hard floor; a remark can never pre-accept it.",
    };
  }
  return { vetoed: false, why: null };
}
