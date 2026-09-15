// B-1017 — the revision-cause vocabulary, mirrored from harmony-web's CHECK constraint
// (`briefs_revision_cause_shape`, migration 20260915160000_b1017_revision_cause.sql).
//
// Every retained brief revision after a lineage's first carries `revision_cause: { source, lines[] }` —
// WHY that revision exists. `source` is one of a CLOSED set the DB CHECK pins; `lines` is the text the
// source produced (a lint's warnings verbatim, a sender's words, a leg's one-line reason). The DB is the
// source of truth for the stored values; revision-cause.test.ts asserts this mirror equals the CHECK
// whenever harmony-web sits beside the checkout.
//
// The two send-back sources are DERIVED by the database from the B-896 provenance row — a caller passes
// only `iterate_feedback` for a send-back and never names a send-back source itself.
export const REVISION_CAUSE_SOURCES = [
  'human-send-back', 'orchestrator-send-back', 'lint-self-review', 'self-review',
  'after-discussion', 'accept-remark', 'refreshed-inputs',
] as const;
export type RevisionCauseSource = (typeof REVISION_CAUSE_SOURCES)[number];
export interface RevisionCause { source: RevisionCauseSource; lines: string[] }

/** Shape guard: a known source and an all-string `lines` array. Tolerant read — anything else is `false`,
 *  never a throw, so a malformed stored value degrades to "no cause" rather than breaking a reader. */
export function isRevisionCause(x: unknown): x is RevisionCause {
  if (!x || typeof x !== 'object') return false;
  const { source, lines } = x as { source?: unknown; lines?: unknown };
  return typeof source === 'string'
    && (REVISION_CAUSE_SOURCES as readonly string[]).includes(source)
    && Array.isArray(lines) && lines.every((l) => typeof l === 'string');
}
