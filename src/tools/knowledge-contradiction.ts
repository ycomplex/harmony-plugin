// ===========================================================================
// KNOWLEDGE-CONTRADICTION DETECTOR (B-838).
//
// A DETERMINISTIC, MECHANICAL detector — NOT an LLM/semantic judgment. Mirrors the shape of
// src/tools/risk-class.ts: pure, dependency-free, conservative-on-ambiguity, and trivially unit
// testable. Given the raw PR diff text and a set of candidate Accepted knowledge entries, it finds
// which entries carry a concrete/named value ("a recorded value") that the diff's REMOVED lines
// contradict — the B-838 problem is "a decision the system has since moved away from still reads as
// Accepted", and this module is the read-time mechanism that surfaces it on the release brief.
//
// THE PROBLEM THIS SOLVES: nothing today fires supersession when later work quietly contradicts an
// Accepted decision's recorded value (B-754's `docker buildx build --platform linux/amd64 ... --push`
// invocation, superseded in prose by B-804's real diff, is the repro). The floor stays FIRES on this
// exact case; churn that merely touches the same value without removing it (a rename, reformatting)
// must NOT fire, or the signal drowns in noise the first week it ships.
//
// THE EXTRACTION RULE (applied SYMMETRICALLY to both an Accepted entry's content and the diff's
// removed lines): fenced code blocks, inline code spans (`` `...` ``, >= MIN_INLINE_CODE_SPAN_LENGTH
// chars), and quoted literal strings (>= MIN_QUOTED_STRING_LENGTH chars) are the candidate "recorded
// values" — the things worth checking for contradiction. Free prose is never a candidate: prose
// disagreement is a judgment call for a human, not a mechanical string match.
//
// THE MATCH RULE: an extracted value found as an EXACT SUBSTRING of the diff's removed-lines text is
// a contradiction CANDIDATE. If that same value is ALSO present in the diff's added-lines text, the
// candidate is BENIGN (churn — the value survived the change, e.g. a rename touched the surrounding
// line but not the recorded token itself); if it is absent from added, the candidate FIRES —
// something the entry states is a fact was REMOVED and not restated.
//
// TWO READ TIERS reach this module's `matchEntryAgainstDiff` (the DB reads that assemble the
// candidate entry set live in briefs.ts, which is impure — this file never touches a client):
//   FLOOR  — the ticket's own `ticket_references_knowledge` links (DIRECT-only, B-838 v1 scope).
//   TIER   — a BOUNDED, content-matched `query_knowledge` search seeded by `deriveSearchTerms` below,
//            NOT restricted to FLOOR (a contradicted entry the ticket never linked still matters).
// Every bound here is a NAMED CONSTANT, in this one file, each with its own unit test — never a
// magic number buried in a comment.
// ===========================================================================

// ---------------------------------------------------------------------------
// Named bounds (B-838 build-step requirement: every bound is a constant here, unit-tested on its own).
// ---------------------------------------------------------------------------

/** Bound #1 — the diff's removed-line SCAN cap. Once this many removed lines have been collected,
 *  scanning stops and the result carries an explicit `truncated` message — NEVER a silent partial
 *  scan. Deliberately generous (most PR diffs are far smaller) — this exists to bound a pathological
 *  diff, not to shrink the common case. */
export const MAX_REMOVED_LINES_SCANNED = 2000;

/** Bound #2 — the extracted-term cap for TIER's search terms. `deriveSearchTerms` extracts candidate
 *  values from the diff's removed lines to seed the bounded `query_knowledge` search; this caps how
 *  many of those values are ever sent, so a huge diff cannot balloon the search into an unbounded
 *  scan of its own. */
export const MAX_TIER_SEARCH_TERMS = 20;

/** Bound #3 — the TIER candidate limit: `query_knowledge({ search, limit: TIER_CANDIDATE_LIMIT })`.
 *  TIER is a BOUNDED search, not a whole-KB scan — this is the cap that keeps it that way. */
export const TIER_CANDIDATE_LIMIT = 20;

/** Bound #4 — the release-brief RENDER cap. Beyond this many touched entries, the brief shows the
 *  first N + "+N more"; the full list is posted as a ticket comment by the caller (finish-work),
 *  never rendered inline past this cap. `capEntriesForRender` below is the one place that applies it. */
export const RENDER_CAP = 5;

/** The inline code span (`` `...` ``) minimum length to count as a candidate recorded value. Below
 *  this, a code span is more likely a short identifier fragment than a recorded literal. Also reused
 *  as the per-line threshold inside a fenced code block (see `extractCandidateValues`). */
export const MIN_INLINE_CODE_SPAN_LENGTH = 6;

/** The quoted literal string ("..."/'...') minimum length to count as a candidate recorded value. */
export const MIN_QUOTED_STRING_LENGTH = 8;

// ---------------------------------------------------------------------------
// Generated / vendored path exclusion — defined EXPLICITLY and LOCALLY (confirmed at plan time: no
// reusable classifier exists anywhere in this repo — checked risk-class.ts and grepped src/tools +
// scripts — nothing to import). A file matching this list is never scanned for contradictions: a
// lockfile or a minified/binary blob can churn every line without representing a single human
// decision, and scanning it would either blow the line cap on noise or produce nonsense candidates.
// ---------------------------------------------------------------------------
const GENERATED_VENDORED_EXCLUDE: RegExp[] = [
  /(^|\/)dist\//,                                    // build output
  /(^|^.*\/)package-lock\.json$/,                     // npm lockfile
  /\.min\.[^/]+$/,                                    // any minified asset (*.min.js, *.min.css, ...)
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|tar|woff2?|ttf|eot|mp4|mov|bin)$/i, // binary/attachment paths
];

/** Is `path` a generated/vendored path the contradiction scan must skip entirely? */
export function isExcludedPath(path: string): boolean {
  return GENERATED_VENDORED_EXCLUDE.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Extraction: the candidate "recorded values" out of a blob of text (entry content OR diff lines).
// ---------------------------------------------------------------------------

/**
 * Extract candidate recorded values from `text`, per the B-838 extraction rule:
 *   1. fenced code blocks — each non-blank line inside the fence, trimmed, >= MIN_INLINE_CODE_SPAN_LENGTH
 *      (masked out before steps 2/3 run, so a fenced block's own backticks/quotes are never re-extracted)
 *   2. inline code spans `` `...` ``, >= MIN_INLINE_CODE_SPAN_LENGTH chars
 *   3. quoted literal strings "..."/'...', >= MIN_QUOTED_STRING_LENGTH chars
 *
 * Pure, order-preserving, de-duplicated. Never throws — empty/undefined input yields `[]`.
 */
export function extractCandidateValues(text: string | undefined | null): string[] {
  if (!text) return [];
  const values: string[] = [];

  // 1. Fenced code blocks first — extract, then MASK (replace with a single space) so the same bytes
  //    can't also be picked up as an inline span or a quoted string in steps 2/3.
  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let working = text.replace(fenceRe, (_match, body: string) => {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_INLINE_CODE_SPAN_LENGTH) values.push(trimmed);
    }
    return ' ';
  });

  // 2. Inline code spans.
  const spanRe = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(working)) !== null) {
    const val = m[1].trim();
    if (val.length >= MIN_INLINE_CODE_SPAN_LENGTH) values.push(val);
  }
  working = working.replace(spanRe, ' ');

  // 3. Quoted literal strings (double or single quotes).
  const quoteRe = /"([^"\n]+)"|'([^'\n]+)'/g;
  while ((m = quoteRe.exec(working)) !== null) {
    const val = (m[1] ?? m[2] ?? '').trim();
    if (val.length >= MIN_QUOTED_STRING_LENGTH) values.push(val);
  }

  // De-duplicate, order-preserving.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** TIER's search terms: candidate values extracted from the diff's removed lines, capped at
 *  MAX_TIER_SEARCH_TERMS. `[]` means "no TIER candidates" — the caller (briefs.ts) reads that as the
 *  diff-content-present-but-empty-after-exclusion/extraction state of the three-state contract. */
export function deriveSearchTerms(removedLines: string[]): string[] {
  return extractCandidateValues(removedLines.join('\n')).slice(0, MAX_TIER_SEARCH_TERMS);
}

// ---------------------------------------------------------------------------
// Diff parsing: raw unified diff text (`git diff origin/main...HEAD`) -> removed/added line arrays,
// after generated/vendored exclusion and the removed-line scan cap.
// ---------------------------------------------------------------------------

export interface ParsedDiff {
  /** Lines removed or replaced (the '-' side of a hunk), leading '-' stripped, across every
   *  non-excluded file. This is what the match rule searches for a contradiction. */
  removedLines: string[];
  /** Lines added (the '+' side of a hunk), leading '+' stripped, across every non-excluded file. Used
   *  ONLY to tell a fires-but-benign candidate from a fires-and-contradicted one — the match rule
   *  never treats an added-only value as a contradiction on its own. */
  addedLines: string[];
  /** Set ONLY when MAX_REMOVED_LINES_SCANNED was hit — an explicit, never-silent degrade. Exact shape:
   *  "contradiction scan truncated: N files / M lines not scanned". */
  truncated?: string;
}

/** Parse raw unified diff text into removed/added lines, skipping excluded paths and stopping at the
 *  removed-line scan cap. Never throws — malformed/empty input yields `{ removedLines: [], addedLines: [] }`. */
export function parseDiff(diffContent: string | undefined | null): ParsedDiff {
  if (!diffContent) return { removedLines: [], addedLines: [] };
  const lines = diffContent.split('\n');
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  let currentExcluded = false;
  let truncatedAtIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) {
      const path = header[2] ?? header[1];
      currentExcluded = isExcludedPath(path);
      continue;
    }
    if (currentExcluded) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line === '---' || line === '+++') continue;

    if (line.startsWith('-')) {
      if (removedLines.length >= MAX_REMOVED_LINES_SCANNED) {
        truncatedAtIndex = i;
        break;
      }
      removedLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      addedLines.push(line.slice(1));
    }
  }

  if (truncatedAtIndex < 0) return { removedLines, addedLines };

  const remainingLines = lines.length - truncatedAtIndex;
  const remainingFiles = lines.slice(truncatedAtIndex).filter((l) => l.startsWith('diff --git ')).length;
  return {
    removedLines,
    addedLines,
    truncated: `contradiction scan truncated: ${remainingFiles} files / ${remainingLines} lines not scanned`,
  };
}

// ---------------------------------------------------------------------------
// Match rule.
// ---------------------------------------------------------------------------

export type ContradictionMatchState = 'fires-and-contradicted' | 'fires-but-benign';

export interface ContradictionMatch {
  state: ContradictionMatchState;
  matchedValues: string[];
}

/**
 * Does `entryContent` carry a recorded value the diff contradicts?
 *
 * Extracts candidate values from `entryContent`, then checks each as an EXACT SUBSTRING of the diff's
 * removed-lines text. A value found only in removed lines FIRES (fires-and-contradicted); a value
 * found in BOTH removed and added lines is churn, not contradiction (fires-but-benign). A value found
 * in neither is not a candidate for this entry at all. Priority: if the entry has ANY
 * fires-and-contradicted value, that is the reported state — a real contradiction is never masked by
 * an unrelated benign match on the same entry.
 *
 * Returns `null` when the entry has no removed-line match at all (the common case — most Accepted
 * entries the diff touches are untouched by THIS diff).
 */
export function matchEntryAgainstDiff(
  entryContent: string | undefined | null,
  removedLines: string[],
  addedLines: string[],
): ContradictionMatch | null {
  const values = extractCandidateValues(entryContent);
  if (values.length === 0) return null;
  const removedText = removedLines.join('\n');
  const addedText = addedLines.join('\n');

  const contradicted: string[] = [];
  const benign: string[] = [];
  for (const v of values) {
    if (!removedText.includes(v)) continue;
    if (addedText.includes(v)) benign.push(v);
    else contradicted.push(v);
  }

  if (contradicted.length > 0) return { state: 'fires-and-contradicted', matchedValues: contradicted };
  if (benign.length > 0) return { state: 'fires-but-benign', matchedValues: benign };
  return null;
}

// ---------------------------------------------------------------------------
// Render cap (Bound #4).
// ---------------------------------------------------------------------------

export interface RenderCapResult<T> {
  shown: T[];
  moreCount: number;
}

/** Apply the RENDER_CAP: the first RENDER_CAP entries, plus a count of how many more exist. The
 *  caller (finish-work) renders `shown` inline and "+`moreCount` more", posting the full list as a
 *  ticket comment — this function only computes the split, it never truncates silently. */
export function capEntriesForRender<T>(entries: T[]): RenderCapResult<T> {
  if (entries.length <= RENDER_CAP) return { shown: entries, moreCount: 0 };
  return { shown: entries.slice(0, RENDER_CAP), moreCount: entries.length - RENDER_CAP };
}
