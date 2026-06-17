// ===========================================================================
// PLUGIN-SIDE MIRROR of the workspace Agent-Trust dial -> behaviour mapping.
//
// !!! DRIFT-SYNC WARNING — KEEP IN LOCKSTEP WITH harmony-web !!!
// Source of truth: web/src/features/agent-trust/lib/trustModel.ts
//   (TrustLevel, ActivityClass, TRUST_MATRIX, DEFAULT_TRUST).
// This is a HAND-MAINTAINED COPY because the plugin is a separate repo/runtime
// that cannot import the harmony-web module. When the web matrix's shape or
// values change, this file MUST be updated to match. The shared / db-driven
// single source of truth is deferred to F5 / Harmony B-355 ("Skills read the
// workspace Agent-Trust dial"); until that lands, this copy is the contract.
//
// In the conductor (B-489 / phase 2b) this mirror is used MAINLY for the
// `cautious == [] (kill-switch)` check: the per-run flag governs forward-gate
// delegation, but a `cautious` workspace dial (autoAdvances === []) forbids ALL
// delegation regardless of the flag. release/verify stay human regardless (the
// hard floor), so the matrix's release/verify classes are moot in v1.
// ===========================================================================

export type TrustLevel = 'cautious' | 'balanced' | 'autonomous';

// Activity classes the dial can permit (mirrors web). Grouping, not per-activity.
export type ActivityClass = 'reversible-rerun' | 'forward-gate' | 'release' | 'verify';

export interface CapabilityProfile {
  // Activity classes the agent WILL advance without asking at this level.
  autoAdvances: ActivityClass[];
}

const LEVELS: TrustLevel[] = ['cautious', 'balanced', 'autonomous'];

// Mirror of web TRUST_MATRIX (trustModel.ts). Values MUST match the web source.
export const TRUST_MATRIX: Record<TrustLevel, CapabilityProfile> = {
  // Cautious: nothing auto-advances — KILL-SWITCH for the conductor (refuse all delegation).
  cautious: { autoAdvances: [] },
  // Balanced (default): auto-applies low-impact reversible re-runs; release + verify stay human.
  balanced: { autoAdvances: ['reversible-rerun'] },
  // Autonomous: runs end-to-end without asking; only the safety rails (release/verify floor) stop it.
  autonomous: { autoAdvances: ['reversible-rerun', 'forward-gate', 'release', 'verify'] },
};

// Mirror of web DEFAULT_TRUST.level — used when a workspace has the empty `{}` dial (all defaults).
export const DEFAULT_TRUST_LEVEL: TrustLevel = 'balanced';

/**
 * Resolve a raw `workspaces.agent_trust` jsonb blob to a TrustLevel.
 * Empty `{}` (the column default) or an unknown level => DEFAULT_TRUST_LEVEL (balanced),
 * mirroring web resolveTrust(). Defensive: never throws on malformed input.
 */
export function resolveTrustLevel(raw: unknown): TrustLevel {
  const level = (raw as { level?: unknown } | null | undefined)?.level;
  return LEVELS.includes(level as TrustLevel) ? (level as TrustLevel) : DEFAULT_TRUST_LEVEL;
}

/**
 * The conductor kill-switch test: a `cautious` workspace dial (autoAdvances === [])
 * forbids ALL per-run delegation. True => run fully controlled and announce.
 */
export function dialForbidsAllDelegation(level: TrustLevel): boolean {
  return TRUST_MATRIX[level].autoAdvances.length === 0;
}
