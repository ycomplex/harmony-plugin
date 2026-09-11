// B-974 (B-936 Class C) — DECLARED VERIFY EVIDENCE, resolved in ONE place.
//
// A project declares, in its `.harmony/project.yml` manifest (B-991), the verify-gate evidence no
// test can produce — a founder click-through, a screenshot, a manual smoke on the deployed thing:
//
//   verify:
//     evidence:
//       - key: founder-clickthrough
//         prompt: "Click through the new flow on staging and confirm it does what the ticket says."
//       - key: ui-screenshot
//         prompt: "Attach a screenshot of the changed screen."
//         applies_to: { paths: ["src/components/**"], labels: ["ux"] }
//
// This module turns those declarations into the two things the verify gate shows a human: synthetic
// criteria-ledger ROWS (`ac_id: "manifest:<key>"`, one of the two `manifest-*` dispositions) and one
// EVIDENCE-LINE CLAUSE. It is deliberately PURE — no database, no clock, no I/O beyond the one thin
// manifest read at the bottom — and it is the SINGLE module both `compose_brief` (src/tools/
// briefs.ts) and `get_build_evidence_status` (src/tools/evidence-status.ts) import, so the brief's
// answer and the tool's answer cannot drift into disagreeing about what is outstanding.
//
// THE FLOOR, which every caller must preserve: no manifest, no `verify.evidence` entries, or no
// manifest root supplied ⇒ NOTHING here fires and the brief is byte-for-byte today's brief. The
// overlay is modelled on `withDiffDerivedRiskClasses` (briefs.ts), which narrows on `frame.kind` and
// returns the caller's own object untouched when it has nothing to say.
//
// AND THE SECOND FLOOR: a MALFORMED manifest never refuses a verify brief. A manifest typo must not
// wedge the one gate whose whole job is letting a human confirm reality — it overlays no rows, says
// loudly on the evidence line what is wrong and which file it is in, and warns at compose. See
// `malformedEvidenceClause` / `malformedEvidenceWarning`.

import { globToRegExp } from '../tools/risk-class.js';
import type { CriterionRow } from '../tools/briefs.js';
import {
  getDeclaredEvidence,
  loadProjectManifest,
  type EvidenceEntry,
  type LoadProjectManifestDeps,
  type ManifestProblem,
} from './project-manifest.js';

/** The `ac_id` prefix every synthetic declared-evidence row carries. Exported so a consumer can tell
 *  a manifest row from a real acceptance criterion without string-matching a literal in two places.
 *  Nothing in the verify render or the gate-slot projection LOOKS UP an acceptance criterion by
 *  `ac_id` (the ledger table never prints it; `criterionSlotRow` passes it through as a string), so a
 *  synthetic id is safe here — verified by executing the render at the design gate. */
export const MANIFEST_EVIDENCE_AC_PREFIX = 'manifest:';

/** The explicit marker a human types to attest a declared entry — on the verify accept's remark, or
 *  as `resolve_brief`'s `detail`. Explicit rather than inferred: an attestation is a human CLAIM, and
 *  the only honest way to record one is to have the human state it. */
export const ATTESTED_MARKER = 'ATTESTED:';

/** Where one declared entry stands for THIS ticket. Exactly three states, by design:
 *   - `declared-unattested` — renders a row, and IS counted as confirmable at this gate.
 *   - `declared-attested`   — renders a row, NOT counted (the human already said it).
 *   - `not-applicable`      — renders NO row and is never counted; NAMED on the evidence line when the
 *                             reason was an UNEVALUABLE matcher rather than a clean non-match. */
export type DeclaredEvidenceState = 'declared-unattested' | 'declared-attested' | 'not-applicable';

/** Why a `not-applicable` entry is not applicable. `unevaluable-paths` is the skip-but-NAME case: the
 *  entry narrows by path and there is no diff to narrow against (an umbrella, a decision-only ticket,
 *  a doc-only ticket with no PR), so the gate does not know whether it applies and must SAY so.
 *  `no-match` is a clean, fully-evaluated non-match and is deliberately silent. */
export type NotApplicableReason = 'unevaluable-paths' | 'no-match';

export interface DeclaredEvidenceResolution {
  key: string;
  prompt: string;
  state: DeclaredEvidenceState;
  not_applicable_reason?: NotApplicableReason;
}

/** Everything the resolution needs about the ticket, all of it supplied by the caller — this module
 *  reads nothing for itself. */
export interface ManifestEvidenceContext {
  /** The build's changed paths. `undefined` means NO DIFF IS AVAILABLE, which is materially different
   *  from `[]` ("the diff is known and touches nothing"): the first makes a `paths` matcher
   *  unevaluable (named on the brief), the second is a clean non-match (silent). */
  changedPaths?: string[];
  /** The ticket's label NAMES. Matched case-insensitively, whole-name (never globbed). */
  labels?: string[];
  /** Keys read back out of this ticket's verify-brief lineage — see `parseAttestedKeys`. */
  attestedKeys?: string[];
}

export interface ManifestEvidenceResult {
  /** Every declared entry, in MANIFEST ORDER, with its resolved state. */
  entries: DeclaredEvidenceResolution[];
  /** The synthetic ledger rows, in manifest order — only for entries that apply. */
  rows: CriterionRow[];
  /** Keys that apply and are NOT attested — the outstanding set. */
  outstanding: string[];
  /** Keys that apply and ARE attested. */
  attested: string[];
  /** Keys skipped because a `paths` matcher could not be evaluated. NAMED, never silent. */
  not_evaluated: string[];
  /** Attested keys naming no declared entry. REPORTED on the brief, never silently dropped: a human
   *  who typed a key that matches nothing has attested nothing, and must be told. */
  unknown_attested_keys: string[];
  /** The evidence-line clause, or `null` when this manifest has nothing to say about this ticket. */
  clause: string | null;
}

// --- applicability ---------------------------------------------------------------------------------

function nonEmpty(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

/** Do any of the build's changed paths match any of the entry's globs? Uses the repo's ONE glob
 *  implementation (`globToRegExp`, exported from risk-class.ts by this ticket) rather than a second. */
function matchesPaths(globs: string[], changedPaths: string[]): boolean {
  const regexes = globs.map(globToRegExp);
  return changedPaths.some((p) => typeof p === 'string' && regexes.some((re) => re.test(p)));
}

/** Whole-name, case-insensitive label match. Deliberately NOT globbed: a label is an exact name the
 *  human picked off a list, and a glob there would make `ux` silently match `ux-debt`. */
function matchesLabels(wanted: string[], labels: string[]): boolean {
  const set = new Set(wanted.map((l) => l.trim().toLowerCase()));
  return labels.some((l) => typeof l === 'string' && set.has(l.trim().toLowerCase()));
}

/** Resolve ONE entry's applicability. An absent (or empty) `applies_to` applies to EVERY ticket; two
 *  matchers present apply on EITHER (a union — see AppliesToSchema's doc comment). */
function resolveApplicability(
  entry: EvidenceEntry,
  ctx: ManifestEvidenceContext,
): { applies: true } | { applies: false; reason: NotApplicableReason } {
  const at = entry.applies_to;
  const hasPaths = nonEmpty(at?.paths);
  const hasLabels = nonEmpty(at?.labels);
  if (!hasPaths && !hasLabels) return { applies: true };

  if (hasLabels && matchesLabels(at!.labels!, ctx.labels ?? [])) return { applies: true };

  if (hasPaths) {
    // No diff at all ⇒ the matcher cannot be evaluated. SKIP BUT NAME — never a silent skip, because
    // "we did not check" and "it does not apply" are different claims and only one of them is true.
    if (ctx.changedPaths === undefined) return { applies: false, reason: 'unevaluable-paths' };
    if (matchesPaths(at!.paths!, ctx.changedPaths)) return { applies: true };
  }

  return { applies: false, reason: 'no-match' };
}

// --- attestation -------------------------------------------------------------------------------------

/** The exact string a human types to attest one entry — rendered into the row's `backed_by` column so
 *  the brief carries its own instructions and no `CriterionRow` field has to be invented for it. */
export function attestationHint(key: string): string {
  return `type ${ATTESTED_MARKER} ${key} in the accept remark box or resolve_brief detail`;
}

/** Parse `ATTESTED: <key>[, <key>]` marker lines out of arbitrary human text (a resolved verify
 *  brief's `resolved_detail`, or the active row's `pending_resolution.detail`).
 *
 *  Line-anchored and case-insensitive, so a marker may sit inside a longer remark; every matching line
 *  contributes, and keys are de-duplicated preserving first-seen order. Pure over its inputs — the
 *  caller does the reading, which is what makes this unit-testable over synthetic lineage rows. */
export function parseAttestedKeys(details: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const detail of details) {
    if (typeof detail !== 'string' || !detail.includes(':')) continue;
    // `m` so the marker can appear on any line of a multi-line remark; `i` because a human typing it
    // by hand is not going to be reliable about case.
    const re = /^[^\S\r\n]*ATTESTED:[^\S\r\n]*(.+)$/gim;
    let match: RegExpExecArray | null;
    while ((match = re.exec(detail)) !== null) {
      for (const raw of match[1].split(',')) {
        const key = raw.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

// --- resolution ----------------------------------------------------------------------------------------

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** THE function. Declared entries + what we know about the ticket ⇒ rows, counts, and the clause.
 *  Pure, total, and never throws: a caller may hand it anything and still get a renderable answer. */
export function resolveManifestEvidence(
  entries: EvidenceEntry[],
  ctx: ManifestEvidenceContext = {},
): ManifestEvidenceResult {
  const attestedKeys = ctx.attestedKeys ?? [];
  const declaredKeys = new Set(entries.map((e) => e.key));

  const resolutions: DeclaredEvidenceResolution[] = [];
  const rows: CriterionRow[] = [];
  const outstanding: string[] = [];
  const attested: string[] = [];
  const not_evaluated: string[] = [];

  for (const entry of entries) {
    const applicability = resolveApplicability(entry, ctx);
    if (!applicability.applies) {
      resolutions.push({
        key: entry.key,
        prompt: entry.prompt,
        state: 'not-applicable',
        not_applicable_reason: applicability.reason,
      });
      if (applicability.reason === 'unevaluable-paths') not_evaluated.push(entry.key);
      continue;
    }

    const isAttested = attestedKeys.includes(entry.key);
    resolutions.push({
      key: entry.key,
      prompt: entry.prompt,
      state: isAttested ? 'declared-attested' : 'declared-unattested',
    });
    rows.push({
      ac_id: `${MANIFEST_EVIDENCE_AC_PREFIX}${entry.key}`,
      text: entry.prompt,
      checked: isAttested,
      disposition: isAttested ? 'manifest-attested' : 'manifest-declared',
      backed_by: isAttested ? `${ATTESTED_MARKER} ${entry.key}` : attestationHint(entry.key),
    });
    if (isAttested) attested.push(entry.key);
    else outstanding.push(entry.key);
  }

  const unknown_attested_keys = attestedKeys.filter((k) => !declaredKeys.has(k));

  const parts: string[] = [];
  if (outstanding.length) parts.push(`${plural(outstanding.length, 'outstanding', 'outstanding')}: ${outstanding.join(', ')}`);
  if (attested.length) parts.push(`${attested.length} attested: ${attested.join(', ')}`);
  if (not_evaluated.length) {
    parts.push(
      `${plural(not_evaluated.length, 'path-narrowed entry', 'path-narrowed entries')} not evaluated — ` +
        `no diff available: ${not_evaluated.join(', ')}`,
    );
  }
  if (unknown_attested_keys.length) {
    parts.push(
      `⚠️ ${ATTESTED_MARKER} names no declared entry: ${unknown_attested_keys.join(', ')} — nothing was attested by it`,
    );
  }

  return {
    entries: resolutions,
    rows,
    outstanding,
    attested,
    not_evaluated,
    unknown_attested_keys,
    clause: parts.length ? `Declared evidence — ${parts.join(' · ')}` : null,
  };
}

// --- the malformed path ------------------------------------------------------------------------------

/** The LOUD evidence-line clause for a manifest that could not be read. Names the file and the
 *  specific problem (`ManifestProblem.message` already leads with the file), and says plainly that no
 *  declared evidence was overlaid — so the reader knows the absence of rows is a failure, not a "this
 *  project declares nothing". The brief is still composed: see this file's header. */
export function malformedEvidenceClause(problem: ManifestProblem): string {
  return `⚠️ Declared verify evidence NOT read (${problem.reason}) — ${problem.message}`;
}

/** The warn-only compose lint for the same condition. A WARNING, never an error: `compose_brief`
 *  gains no new way to refuse a brief (the B-876 frame posture), so an unattended leg can never
 *  hard-stop on a manifest typo. */
export function malformedEvidenceWarning(problem: ManifestProblem): string {
  return (
    `The project manifest declares verify evidence that could NOT be read (${problem.reason}): ` +
    `${problem.message} No declared-evidence rows were overlaid onto this brief — fix the manifest ` +
    'and re-compose, or accept knowing the declared evidence was not checked.'
  );
}

// --- the one thin read ---------------------------------------------------------------------------------

/** What a manifest read yielded for declared evidence. `none` covers ALL THREE floor cases the
 *  overlay must treat identically — no root supplied, no manifest file, manifest declaring no
 *  `verify.evidence` entries — so a caller has exactly one condition to check before doing nothing. */
export type DeclaredEvidenceRead =
  | { kind: 'none' }
  | { kind: 'malformed'; problem: ManifestProblem }
  | { kind: 'entries'; file: string; entries: EvidenceEntry[] };

/** Read `<manifestRoot>/.harmony/project.yml` and return only its declared evidence.
 *
 *  `manifestRoot` is an EXPLICIT absolute path from the caller, never `process.cwd()` — the MCP
 *  server's working directory is not reliably the repo of record, and guessing it would make the
 *  overlay silently read the wrong project's manifest (or none).
 *
 *  Never throws: `loadProjectManifest` returns its problems rather than raising, and a malformed
 *  manifest becomes a reportable clause here rather than a failed compose. */
export function readDeclaredEvidence(
  manifestRoot: string | undefined,
  deps?: LoadProjectManifestDeps,
): DeclaredEvidenceRead {
  if (typeof manifestRoot !== 'string' || manifestRoot.trim().length === 0) return { kind: 'none' };
  const result = loadProjectManifest(manifestRoot, deps ?? {});
  if (result.kind === 'absent') return { kind: 'none' };
  if (result.kind === 'malformed') return { kind: 'malformed', problem: result.problem };
  const entries = getDeclaredEvidence(result.manifest);
  if (entries.length === 0) return { kind: 'none' };
  return { kind: 'entries', file: result.file, entries };
}
