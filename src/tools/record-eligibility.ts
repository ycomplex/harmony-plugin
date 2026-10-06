// B-1062 — the eligibility evaluator for `harmony record` (the gate-walk core, src/tools/record-walk.ts).
//
// Five items, deterministic and mechanical (mirrors src/tools/risk-class.ts's own "not an LLM/semantic
// judgment" discipline — this file is dependency-free-of-I/O in its `evaluateEligibility` core, exactly
// like `detectRiskClasses`), in THREE tiers per item: 'pass' / 'fail' / 'unattested'. Every item reports
// the VALUE it read, not just the verdict — `harmony record --check` prints both (step 8's AC).
//
// REFUSE-BEFORE-WRITE: the gate-walk core (record-walk.ts) calls `evaluateEligibility` BEFORE it resolves
// a task id or touches the database — see that file's header for why the ticket must be left
// byte-identical on a refusal.
//
// FOUR items are auto-derived and can PASS or FAIL; the FIFTH (the verify-walk attestation) can only ever
// be 'pass' or 'unattested' — it is NEVER auto-passed, and NEVER auto-failed either: it is a fact only a
// human attestation can supply (see `evaluateVerifyWalkItem` below).

import { detectRiskClasses, PATH_GLOB_TABLE, globToRegExp, type RiskClass } from './risk-class.js';
import {
  evaluateScopeBudget,
  DEFAULT_SCOPE_BUDGET,
  type NumstatEntry,
  type ScopeBudget,
  type ScopeEvaluation,
} from './fasttrack-scope.js';
import { getScopeBudget } from '../config/project-manifest.js';
import type { ProjectManifest } from '../config/project-manifest.js';

export type EligibilityVerdict = 'pass' | 'fail' | 'unattested';

export interface EligibilityItemResult {
  /** Machine key — stable across releases, used by tests and by any future programmatic reader. */
  item: 'multi_repo' | 'migration' | 'risk_class' | 'single_sentence_change' | 'verify_walk_attestation';
  /** Human label, as `--check` prints it. */
  label: string;
  verdict: EligibilityVerdict;
  /** The value this verdict was READ FROM — e.g. "repos: 1 (harmony-plugin)", "risk_classes: []",
   *  "verify-walk: UNATTESTED (no --attest-walk given)". Always present, even on a pass. */
  value: string;
  /** Present on 'fail' — WHY, beyond what `value` already states. */
  detail?: string;
}

export interface EligibilityEvidenceLink {
  url: string;
  /** `owner/repo`, when derivable from the URL (e.g. a GitHub PR/commit/compare link). Absent when the
   *  link's repo could not be determined (an opaque URL, or `gh` was unavailable) — see
   *  `gatherEvidenceSignals` in record-evidence.ts, the one caller that fills this in via `gh`. An absent
   *  repo contributes NOTHING to the multi-repo count — it is neither a same-repo nor a different-repo
   *  signal, which is the conservative (never-silently-fail-closed-on-missing-data) reading: the multi-repo
   *  FLOOR exists to catch evidence that plainly spans repos, not to penalize an unparseable link. */
  repo?: string;
  /** Changed file paths this evidence touches, when known (e.g. `gh pr diff --name-only`). Absent when
   *  unknown. Feeds BOTH the migration-path check and the risk-class detector's `changedPaths`. */
  paths?: string[];
}

export interface EvaluateEligibilityInput {
  /** The human's one-line account of the change. Also the ROUGH source for `doc.decide`/`frame.solving`
   *  in the gate-walk core, but this module only ever READS it for the single-sentence-shape heuristic. */
  summary: string;
  evidence: EligibilityEvidenceLink[];
  /** `--attest-walk "<who/what was walked>"` — see item (e) below. Blank/whitespace-only reads as absent
   *  (mirrors this repo's "blank ≡ absent" convention, e.g. resolveBrief's remark handling). */
  attestWalk?: string;
}

export interface EligibilityReport {
  items: EligibilityItemResult[];
  /** true iff EVERY item is 'pass'. Both 'fail' and 'unattested' block eligibility — the ticket's own
   *  eligibility gate never distinguishes "known-bad" from "unknown" when deciding whether to proceed;
   *  it only distinguishes them in how it's REPORTED (see `describeIneligibility` in record-walk.ts). */
  eligible: boolean;
}

// ---------------------------------------------------------------------------
// (a) multi-repo — fail if the evidence links span more than one repo.
// ---------------------------------------------------------------------------

function evaluateMultiRepoItem(evidence: EligibilityEvidenceLink[]): EligibilityItemResult {
  const repos = Array.from(new Set(evidence.map((e) => e.repo).filter((r): r is string => !!r)));
  const value = `repos: ${repos.length} (${repos.join(', ') || 'none determined'})`;
  if (repos.length > 1) {
    return {
      item: 'multi_repo', label: 'Single repo', verdict: 'fail', value,
      detail: `evidence spans ${repos.length} repos — a recorded walk covers exactly one repo's worth of change; split multi-repo work into a ticket per repo, or use harmony conduct instead.`,
    };
  }
  return { item: 'multi_repo', label: 'Single repo', verdict: 'pass', value };
}

// ---------------------------------------------------------------------------
// (b) migration — fail if the evidence touches a migration path (PATH_GLOB_TABLE['data-migration'],
// the SAME table the build-gate risk floor uses — no second glob semantics invented here).
// ---------------------------------------------------------------------------

const MIGRATION_GLOB_REGEXES = PATH_GLOB_TABLE['data-migration'].map(globToRegExp);

function evaluateMigrationItem(evidence: EligibilityEvidenceLink[]): EligibilityItemResult {
  const allPaths = evidence.flatMap((e) => e.paths ?? []);
  const migrationPaths = allPaths.filter((p) => MIGRATION_GLOB_REGEXES.some((re) => re.test(p)));
  const value = `migration paths: ${migrationPaths.length} (${migrationPaths.slice(0, 5).join(', ') || 'none'})`;
  if (migrationPaths.length > 0) {
    return {
      item: 'migration', label: 'No migration', verdict: 'fail', value,
      detail: 'evidence touches a DB migration path — a schema change is exactly the class this floor exists to catch; use harmony conduct instead.',
    };
  }
  return { item: 'migration', label: 'No migration', verdict: 'pass', value };
}

// ---------------------------------------------------------------------------
// (c) auth / shared-core / irreversible-destructive risk class — fail if detectRiskClasses (over the
// summary text + evidence paths) returns any of those three classes. Deliberately NOT data-migration —
// item (b) above already covers migration on its own, narrower, evidence-path-only signal.
// ---------------------------------------------------------------------------

const GATED_RISK_CLASSES: RiskClass[] = ['auth', 'irreversible-destructive', 'shared-core'];

function evaluateRiskClassItem(summary: string, evidence: EligibilityEvidenceLink[]): EligibilityItemResult {
  const changedPaths = evidence.flatMap((e) => e.paths ?? []);
  const classes = detectRiskClasses({ text: summary, changedPaths });
  const gated = classes.filter((c) => GATED_RISK_CLASSES.includes(c));
  const value = `risk_classes: [${classes.join(', ')}]`;
  if (gated.length > 0) {
    return {
      item: 'risk_class', label: 'No auth/shared-core/irreversible-destructive risk', verdict: 'fail', value,
      detail: `tripped: ${gated.join(', ')} — a high-consequence risk class is the conductor's own non-discretionary floor (B-493); a recorded walk carries no live gate to pause on it, so it refuses instead. Use harmony conduct.`,
    };
  }
  return { item: 'risk_class', label: 'No auth/shared-core/irreversible-destructive risk', verdict: 'pass', value };
}

// ---------------------------------------------------------------------------
// (d) "no known reproduction or one-sentence-statable change" — fail if the human's summary cannot be
// read as a single-sentence change statement.
//
// THE HEURISTIC (documented here, deliberately simple and mechanical — a length/shape check, never a
// semantic judgment): the summary must (1) contain at most ONE sentence-terminator run (a `.`/`!`/`?`
// sequence not at the very end counts as a second sentence; a single trailing terminator is fine and
// ignored), and (2) be at most SENTENCE_WORD_LIMIT words. Both are the same shape/threshold this repo
// already uses for "is this legible as one BLUF sentence" (see briefs.ts's `SENTENCE_WORD_LIMIT` /
// `analyzeLegibility`) — reused as a CONSTANT VALUE, not as an import, to keep this module free of a
// coupling to briefs.ts's much larger surface for one shared number.
// ---------------------------------------------------------------------------

const SENTENCE_WORD_LIMIT = 50;

function isSingleSentenceShaped(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > SENTENCE_WORD_LIMIT) return false;
  // Strip exactly one trailing terminator run, then check for any terminator left inside — that is a
  // second sentence. ("e.g." / "i.e." / decimals are a known false-fail this simple heuristic accepts;
  // it is conservative-on-ambiguity in the SAME direction as risk-class.ts — a false 'fail' costs one
  // human --attest-walk-style re-phrase, never a silent pass-through.)
  const withoutTrailingTerminator = trimmed.replace(/[.!?]+\s*$/, '');
  return !/[.!?]/.test(withoutTrailingTerminator);
}

function evaluateSingleSentenceItem(summary: string): EligibilityItemResult {
  const trimmed = summary.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const value = `summary: ${wordCount} words, ${trimmed ? '"' + (trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed) + '"' : '(empty)'}`;
  if (!isSingleSentenceShaped(summary)) {
    return {
      item: 'single_sentence_change', label: 'Single-sentence-statable change', verdict: 'fail', value,
      detail: `not readable as one sentence (either >${SENTENCE_WORD_LIMIT} words, or more than one sentence-terminator run) — a recorded walk needs a change a human can state in one sentence; use harmony conduct for anything that needs more room.`,
    };
  }
  return { item: 'single_sentence_change', label: 'Single-sentence-statable change', verdict: 'pass', value };
}

// ---------------------------------------------------------------------------
// (e) a verify walk over 5 minutes — the ONE item NEVER auto-passed. Requires an explicit human
// attestation (`--attest-walk "<who/what was walked>"`); reported UNATTESTED (never failed) when absent.
// ---------------------------------------------------------------------------

function evaluateVerifyWalkItem(attestWalk: string | undefined): EligibilityItemResult {
  const trimmed = typeof attestWalk === 'string' ? attestWalk.trim() : '';
  if (!trimmed) {
    return {
      item: 'verify_walk_attestation', label: 'Verify walk (5+ min) attested', verdict: 'unattested',
      value: 'verify-walk: UNATTESTED (no --attest-walk given)',
    };
  }
  return {
    item: 'verify_walk_attestation', label: 'Verify walk (5+ min) attested', verdict: 'pass',
    value: `verify-walk: ATTESTED ("${trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed}")`,
  };
}

/** Formats one eligibility item's verdict line, in the shape `harmony record --check` and
 *  `harmony fasttrack check` both render verbatim (AC1's "same output shape") — ONE formatter,
 *  never two copies that could drift. */
export function formatEligibilityLine(commandLabel: string, ticket: string, item: EligibilityItemResult): string {
  return `${commandLabel} ${ticket}: ${item.label} — ${item.verdict.toUpperCase()} (${item.value}${item.detail ? ' — ' + item.detail : ''})`;
}

// ---------------------------------------------------------------------------
// The whole evaluator — pure, five items, in the ticket's own (a)-(e) order.
// ---------------------------------------------------------------------------

export function evaluateEligibility(input: EvaluateEligibilityInput): EligibilityReport {
  const items: EligibilityItemResult[] = [
    evaluateMultiRepoItem(input.evidence),
    evaluateMigrationItem(input.evidence),
    evaluateRiskClassItem(input.summary, input.evidence),
    evaluateSingleSentenceItem(input.summary),
    evaluateVerifyWalkItem(input.attestWalk),
  ];
  return { items, eligible: items.every((i) => i.verdict === 'pass') };
}

// ---------------------------------------------------------------------------
// B-1073 — fast-track admission: a RE-INTERPRETATION of the same five-item report above, not a
// second evaluator. `evaluateEligibility`'s own `eligible` flag blocks on ANY non-pass item,
// including an `unattested` verify-walk attestation (item e) — correct for `harmony record`, which
// has no live gate to attest a walk from. The fast-track daemon leg is different: it DOES have a
// live build leg that will itself walk the ticket, so an `unattested` verify-walk item alone must
// NOT block admission — only a `fail` (on any item) or a non-verify_walk_attestation `unattested`
// blocks. (`verify_walk_attestation` itself never returns a 'fail' — see evaluateVerifyWalkItem
// above — so in practice this carve-out is the ONLY way item (e) can read non-blocking.)
// ---------------------------------------------------------------------------

/** B-1073 step 4 — is `report` admissible for a fast-track daemon leg? `evaluateEligibility`'s own
 *  report, re-interpreted: admissible iff every item EXCEPT `verify_walk_attestation` is `'pass'` —
 *  an `unattested` verdict on `verify_walk_attestation` ALONE does not block; any other item's
 *  `fail` blocks. Pure — never touches the network/DB, never re-runs the evaluator. */
export function admissibleForFastTrack(
  report: EligibilityReport,
): { admissible: boolean; blockingItems: EligibilityItemResult[] } {
  const blockingItems = report.items.filter(
    (item) => !(item.verdict === 'pass' || (item.item === 'verify_walk_attestation' && item.verdict === 'unattested')),
  );
  return { admissible: blockingItems.length === 0, blockingItems };
}

/** B-1073 step 5 — render an inadmissible fast-track ticket's verdict as a park-comment string,
 *  reusing `describeIneligibility`'s (`src/tools/record-walk.ts`) wording convention — list every
 *  blocking item's label/verdict/value/detail, one per line. Deliberately duplicated rather than
 *  imported: `record-walk.ts` already imports THIS module (`record-eligibility.ts`), so importing
 *  the other way would cycle; the wording is small enough that a hand-kept parallel is the accepted
 *  cost (same tradeoff `src/config/run-config.ts`'s own `DEFAULT_SUPABASE_URL`/`KNOWN_REFS`
 *  duplication note documents).
 *
 *  CALLER NOTE — HONEST SCOPING (this is NOT wired up anywhere yet): this helper has no caller in
 *  this ticket. The daemon's ACTUAL admission check — the thing that would call
 *  `admissibleForFastTrack` at fire time and, on an inadmissible report, park the conduction with
 *  this comment — is a larger daemon-architecture change than B-1073's own ratified scope covers
 *  (the daemon fires a leg through its existing `src/daemon/scheduler.ts` / `container/provision.sh`
 *  machinery, which this ticket does not redesign). A FUTURE ticket wires this into
 *  `src/daemon/scheduler.ts`'s own fire-time dispatch loop: call `admissibleForFastTrack`, and on
 *  `admissible: false`, comment this formatter's output on the ticket and park it (mirroring the
 *  `advance_workflow({ activity: 'parking' })` convention `skills/start-work/SKILL.md`'s FAILURE
 *  PATH already uses) instead of firing the leg. */
export function formatInadmissibleFastTrackVerdict(report: EligibilityReport): string {
  const { blockingItems } = admissibleForFastTrack(report);
  const lines = blockingItems.map(
    (item) => `  - ${item.label}: ${item.verdict.toUpperCase()} (${item.value}${item.detail ? ' — ' + item.detail : ''})`,
  );
  return (
    `harmony fast-track refuses admission — ${blockingItems.length} eligibility item(s) blocked:\n` +
    lines.join('\n') +
    `\nParked pending human review. Use \`harmony conduct <ticket>\` to walk this ticket's gates ` +
    'live, or address the blocking item(s) above and retry the fast-track run.'
  );
}

/** B-1073 step 6 — the pre-PR-open re-check point: re-run the SAME five-item evaluator against the
 *  real diff's changed paths, rather than whatever paths were known at admission time (step 4,
 *  before any code existed). A thin named wrapper, not a new evaluator — `attestWalk` is
 *  deliberately omitted (`undefined`): this re-check is about the DIFF, not a second attestation
 *  prompt.
 *
 *  CALLER NOTE: see `checkPrePrOpenEligibility` immediately below — the named, documented wrapper
 *  the fast-track build leg's own prose (`skills/start-work/SKILL.md`'s O3, `skills/harmony-conduct
 *  /SKILL.md`'s fast-track paragraph) now calls BY NAME before `gh pr create`. */
export function reEvaluateEligibilityAgainstDiff(summary: string, changedPaths: string[]): EligibilityReport {
  return evaluateEligibility({
    summary,
    evidence: [{ url: '', paths: changedPaths }],
    attestWalk: undefined,
  });
}

/** B-1073 (post-review wiring) — the pre-PR-open admission DECISION, not just the re-evaluated
 *  report: wraps `reEvaluateEligibilityAgainstDiff` with the SAME admission interpretation
 *  `admissibleForFastTrack` applies at step 4 (an unattested verify-walk item never blocks; any
 *  other item's `fail` does), so a build leg gets one `allowed` boolean to branch on rather than
 *  re-deriving the same interpretation a second time. This is the ONE function name
 *  `skills/start-work/SKILL.md`'s O3 (the fast-track-only pre-`gh pr create` sub-step) and
 *  `skills/harmony-conduct/SKILL.md`'s fast-track paragraph both cite — so the skill-level
 *  instruction and this code are one claim, not two independently-drifting ones.
 *
 *  CALLER NOTE — HONEST SCOPING (still true after naming this function in the skill prose above):
 *  this function has NO call site anywhere in this repository's own TypeScript. "The fast-track
 *  build leg" is driven by an interactive Claude Code session following `start-work`'s SKILL.md
 *  prose (O3) — there is no daemon-side "open the PR" dispatcher in this codebase for a unit test
 *  to exercise end to end (unlike `src/daemon/scheduler.ts`'s admission check at the FIRE path,
 *  which genuinely is daemon code and genuinely is wired/tested there). What IS real: this function
 *  is exported, pure, and pinned by a contract test
 *  (`src/tools/pre-pr-open-eligibility-contract.test.ts`), so the skill instruction that now names
 *  it has a concrete, already-tested primitive to call once a future ticket adds that dispatcher —
 *  never a prose claim with nothing behind it. */
export function checkPrePrOpenEligibility(
  summary: string,
  changedPaths: string[],
): { allowed: boolean; verdict: EligibilityReport } {
  const verdict = reEvaluateEligibilityAgainstDiff(summary, changedPaths);
  const { admissible } = admissibleForFastTrack(verdict);
  return { allowed: admissible, verdict };
}

/** B-1073 step 7 — [depends on B-1072, now merged] the SAME scope-guard `harmony fasttrack
 *  scope-check` (`src/cli/commands/fasttrack.ts`'s `resolveScopeBudget`) already runs, reused
 *  verbatim rather than reimplemented: a manifest-declared `fasttrack.scope_budget` override
 *  (partial — either field may be omitted and falls back to the default) merged over
 *  `DEFAULT_SCOPE_BUDGET`, then `evaluateScopeBudget` over the supplied numstat entries. `manifest`
 *  is nullable — pass `null` when no `.harmony/project.yml` was found/parsed, same convention as
 *  every other `ProjectManifest | null` consumer in this repo; this function supplies the "empty
 *  manifest" default itself rather than requiring the caller to construct one. */
export function checkFastTrackScopeBudget(
  entries: NumstatEntry[],
  manifest: ProjectManifest | null,
): ScopeEvaluation {
  const override = manifest ? getScopeBudget(manifest) : {};
  const budget: ScopeBudget = {
    files: override.files ?? DEFAULT_SCOPE_BUDGET.files,
    lines: override.lines ?? DEFAULT_SCOPE_BUDGET.lines,
  };
  return evaluateScopeBudget(entries, budget);
}

// ---------------------------------------------------------------------------
// Evidence gathering via `gh` — reads repo + changed paths for each evidence link, so the eligibility
// items above have real values to evaluate rather than the caller having to derive them by hand. The
// CLI already assumes `gh` is available (per `finish-work`'s own convention).
//
// INJECTABLE, so `evaluateEligibility` above stays pure/pure-testable and this I/O sliver is the only
// thing a test needs to fake. A link whose repo/paths can't be determined (a non-PR URL, or `gh` itself
// failing) degrades to `{ url }` alone — see `EligibilityEvidenceLink.repo`'s doc comment for why an
// absent repo is the conservative, non-penalizing reading rather than a hard failure.
// ---------------------------------------------------------------------------

export type RunGhCommand = (args: string[]) => Promise<string>;

const GITHUB_PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/i;

/** The default `RunGhCommand` — shells out to the real `gh` CLI via `execFile` (never `exec`/a shell
 *  string, so a URL containing shell metacharacters is never interpreted). Exported so a caller that
 *  wants the real behavior doesn't have to re-derive this wiring. */
export async function runGhCommand(args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return await new Promise<string>((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Gather `{ repo, paths }` for one evidence link, best-effort. Only GitHub PR URLs are parsed today
 * (`https://github.com/<owner>/<repo>/pull/<number>`) — any other shape (a commit link, an external doc,
 * a screenshot) yields `{ url }` alone, which the eligibility items above already treat as a neutral,
 * non-contributing signal.
 */
export async function gatherOneEvidenceLink(
  url: string,
  runGh: RunGhCommand,
): Promise<EligibilityEvidenceLink> {
  const match = GITHUB_PR_URL.exec(url.trim());
  if (!match) return { url };
  const [, owner, repo] = match;
  try {
    const out = await runGh(['pr', 'diff', url, '--name-only']);
    const paths = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return { url, repo: `${owner}/${repo}`, paths };
  } catch {
    // `gh` unavailable/unauthenticated/the PR is gone — degrade to "repo known, paths unknown" rather
    // than failing the whole gather. The migration/risk-class items simply see no paths for this link.
    return { url, repo: `${owner}/${repo}` };
  }
}

/** Gather every evidence link, in order, sequentially (evidence lists are small — a handful of PR
 *  links — so there is no real benefit to parallelizing against `gh`'s own rate limits). */
export async function gatherEvidenceSignals(
  urls: string[],
  runGh: RunGhCommand = runGhCommand,
): Promise<EligibilityEvidenceLink[]> {
  const out: EligibilityEvidenceLink[] = [];
  for (const url of urls) {
    out.push(await gatherOneEvidenceLink(url, runGh));
  }
  return out;
}
