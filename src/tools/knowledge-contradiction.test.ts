import { describe, it, expect } from 'vitest';
import {
  extractCandidateValues,
  deriveSearchTerms,
  parseDiff,
  matchEntryAgainstDiff,
  capEntriesForRender,
  isExcludedPath,
  MAX_REMOVED_LINES_SCANNED,
  MAX_TIER_SEARCH_TERMS,
  TIER_CANDIDATE_LIMIT,
  RENDER_CAP,
  MIN_INLINE_CODE_SPAN_LENGTH,
  MIN_QUOTED_STRING_LENGTH,
} from './knowledge-contradiction.js';

// B-754's recorded value, exactly as it appears (real repro string) — reused across several fixtures
// below so the positive control and the truncation fixture share the same real-world shape.
const B754_VALUE = 'docker buildx build --platform linux/amd64 -t harmony/plugin-build:latest --push';

describe('extractCandidateValues', () => {
  it('extracts an inline code span >= MIN_INLINE_CODE_SPAN_LENGTH chars', () => {
    expect(extractCandidateValues(`Run \`${B754_VALUE}\` to publish.`)).toEqual([B754_VALUE]);
  });

  it('does not extract an inline code span below the minimum length', () => {
    expect(extractCandidateValues('Use `curl` here.')).toEqual([]); // 4 chars < MIN_INLINE_CODE_SPAN_LENGTH
  });

  it('extracts a quoted literal string >= MIN_QUOTED_STRING_LENGTH chars', () => {
    expect(extractCandidateValues('The env var is "HARMONY_API_TOKEN".')).toEqual(['HARMONY_API_TOKEN']);
  });

  it('does not extract a quoted string below the minimum length', () => {
    expect(extractCandidateValues('Say "hi" back.')).toEqual([]); // 2 chars < MIN_QUOTED_STRING_LENGTH
  });

  it('extracts each non-blank line of a fenced code block, trimmed', () => {
    const text = ['```bash', B754_VALUE, '', 'echo done', '```'].join('\n');
    expect(extractCandidateValues(text)).toEqual([B754_VALUE, 'echo done']);
  });

  it('does not double-extract a fenced block\'s content as an inline span or quote', () => {
    const text = ['```', `"${B754_VALUE}"`, '```'].join('\n');
    const values = extractCandidateValues(text);
    expect(values).toEqual([`"${B754_VALUE}"`]);
  });

  it('de-duplicates, order-preserving', () => {
    expect(extractCandidateValues('`repeated value` and `repeated value` again')).toEqual(['repeated value']);
  });

  it('never throws on empty/undefined/null input', () => {
    expect(extractCandidateValues('')).toEqual([]);
    expect(extractCandidateValues(undefined)).toEqual([]);
    expect(extractCandidateValues(null)).toEqual([]);
  });
});

describe('bound #2 — MAX_TIER_SEARCH_TERMS (deriveSearchTerms)', () => {
  it('is 20', () => {
    expect(MAX_TIER_SEARCH_TERMS).toBe(20);
  });

  it('caps the extracted terms at MAX_TIER_SEARCH_TERMS', () => {
    const removedLines = Array.from({ length: MAX_TIER_SEARCH_TERMS + 5 }, (_, i) => `\`distinct-value-${i}-long-enough\``);
    const terms = deriveSearchTerms(removedLines);
    expect(terms).toHaveLength(MAX_TIER_SEARCH_TERMS);
  });

  it('returns [] ("no TIER candidates") when nothing extractable is in the removed lines', () => {
    expect(deriveSearchTerms(['plain prose line one', 'plain prose line two'])).toEqual([]);
  });
});

describe('bound #3 — TIER_CANDIDATE_LIMIT', () => {
  it('is 20', () => {
    expect(TIER_CANDIDATE_LIMIT).toBe(20);
  });
});

describe('isExcludedPath (generated/vendored exclusion)', () => {
  it('excludes dist/**, package-lock.json, *.min.*, and binary/attachment paths', () => {
    expect(isExcludedPath('dist/index.js')).toBe(true);
    expect(isExcludedPath('plugin/dist/bin/harmony.js')).toBe(true);
    expect(isExcludedPath('package-lock.json')).toBe(true);
    expect(isExcludedPath('web/package-lock.json')).toBe(true);
    expect(isExcludedPath('assets/vendor.min.js')).toBe(true);
    expect(isExcludedPath('docs/diagram.png')).toBe(true);
    expect(isExcludedPath('fonts/Inter.woff2')).toBe(true);
  });

  it('does not exclude ordinary source paths', () => {
    expect(isExcludedPath('src/tools/knowledge-contradiction.ts')).toBe(false);
    expect(isExcludedPath('plugin/container/README.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDiff + bound #1 (MAX_REMOVED_LINES_SCANNED) — includes the required truncation fixture.
// ---------------------------------------------------------------------------

function unifiedDiffFile(path: string, removed: string[], added: string[] = []): string {
  const hunk = [
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `index 0000000..1111111 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    hunk,
  ].join('\n');
}

describe('parseDiff', () => {
  it('is 1', () => {
    // sanity: MAX_REMOVED_LINES_SCANNED must be a real positive bound
    expect(MAX_REMOVED_LINES_SCANNED).toBeGreaterThan(0);
  });

  it('collects removed and added lines, stripping the +/- prefix', () => {
    const diff = unifiedDiffFile('plugin/container/README.md', ['old line'], ['new line']);
    const parsed = parseDiff(diff);
    expect(parsed.removedLines).toEqual(['old line']);
    expect(parsed.addedLines).toEqual(['new line']);
    expect(parsed.truncated).toBeUndefined();
  });

  it('excludes a generated/vendored path entirely — its removed lines never count toward the cap', () => {
    const diff = unifiedDiffFile('package-lock.json', ['"lockfileVersion": 2']);
    const parsed = parseDiff(diff);
    expect(parsed.removedLines).toEqual([]);
  });

  it('BOUND #1 fixture — exactly at the cap does not truncate; one past it does', () => {
    const atCap = unifiedDiffFile('a.txt', Array.from({ length: MAX_REMOVED_LINES_SCANNED }, (_, i) => `line ${i}`));
    expect(parseDiff(atCap).truncated).toBeUndefined();
    expect(parseDiff(atCap).removedLines).toHaveLength(MAX_REMOVED_LINES_SCANNED);

    const overCap = unifiedDiffFile('b.txt', Array.from({ length: MAX_REMOVED_LINES_SCANNED + 1 }, (_, i) => `line ${i}`));
    const parsed = parseDiff(overCap);
    expect(parsed.truncated).toBeDefined();
    expect(parsed.truncated).toMatch(/^contradiction scan truncated: \d+ files? \/ \d+ lines not scanned$/);
    expect(parsed.removedLines).toHaveLength(MAX_REMOVED_LINES_SCANNED);
  });

  it('never throws on empty/undefined/null input', () => {
    expect(parseDiff('')).toEqual({ removedLines: [], addedLines: [] });
    expect(parseDiff(undefined)).toEqual({ removedLines: [], addedLines: [] });
    expect(parseDiff(null)).toEqual({ removedLines: [], addedLines: [] });
  });
});

// ---------------------------------------------------------------------------
// The three required contract fixtures.
// ---------------------------------------------------------------------------

describe('matchEntryAgainstDiff — B-838 contract fixtures', () => {
  it('POSITIVE CONTROL: fires-and-contradicted — B-754/B-804 repro (recorded value removed, not restated)', () => {
    const entryContent = `Decision: publish with \`${B754_VALUE}\`.`;
    const diff = unifiedDiffFile(
      'plugin/container/README.md',
      [B754_VALUE],
      ['docker buildx build --platform linux/amd64,linux/arm64 -t harmony/plugin-build:latest --push'],
    );
    const parsed = parseDiff(diff);
    const match = matchEntryAgainstDiff(entryContent, parsed.removedLines, parsed.addedLines);
    expect(match).toEqual({ state: 'fires-and-contradicted', matchedValues: [B754_VALUE] });
  });

  it('FIRES-BUT-BENIGN: a rename/churn fixture — the recorded value survives in BOTH removed and added lines', () => {
    const entryContent = 'Decision: the retry ceiling is `MAX_RETRY_COUNT`.';
    const diff = unifiedDiffFile('src/worker.ts', ['  const MAX_RETRY_COUNT = 3;'], ['  const MAX_RETRY_COUNT = 5;']);
    const parsed = parseDiff(diff);
    const match = matchEntryAgainstDiff(entryContent, parsed.removedLines, parsed.addedLines);
    expect(match).toEqual({ state: 'fires-but-benign', matchedValues: ['MAX_RETRY_COUNT'] });
  });

  it('TRUNCATION: an entry whose value sits past the cap is invisible to the (explicitly degraded) scan', () => {
    const paddingLines = Array.from({ length: MAX_REMOVED_LINES_SCANNED }, (_, i) => `padding line ${i}`);
    const diff = unifiedDiffFile('a.txt', [...paddingLines, B754_VALUE]);
    const parsed = parseDiff(diff);
    expect(parsed.truncated).toBeDefined();
    // The value that would have fired sits past the cap — the scan never sees it, and the caller must
    // surface `truncated` rather than silently reporting a clean does-not-fire.
    const match = matchEntryAgainstDiff(`Decision: \`${B754_VALUE}\`.`, parsed.removedLines, parsed.addedLines);
    expect(match).toBeNull();
  });

  it('no match at all -> null (most entries are untouched by a given diff)', () => {
    const entryContent = 'Decision: `some other recorded value` applies.';
    const diff = unifiedDiffFile('a.txt', ['totally unrelated removed line']);
    const parsed = parseDiff(diff);
    expect(matchEntryAgainstDiff(entryContent, parsed.removedLines, parsed.addedLines)).toBeNull();
  });

  it('a real contradiction is never masked by an unrelated benign match on the same entry', () => {
    const entryContent = 'Decision: `RETAINED_TOKEN` stays, but `REMOVED_TOKEN_LITERAL` no longer applies.';
    const diff = unifiedDiffFile(
      'a.txt',
      ['  const RETAINED_TOKEN = 1;', '  const REMOVED_TOKEN_LITERAL = 2;'],
      ['  const RETAINED_TOKEN = 1;'],
    );
    const parsed = parseDiff(diff);
    const match = matchEntryAgainstDiff(entryContent, parsed.removedLines, parsed.addedLines);
    expect(match?.state).toBe('fires-and-contradicted');
    expect(match?.matchedValues).toEqual(['REMOVED_TOKEN_LITERAL']);
  });
});

// ---------------------------------------------------------------------------
// Bound #4 — RENDER_CAP / capEntriesForRender.
// ---------------------------------------------------------------------------

describe('bound #4 — RENDER_CAP (capEntriesForRender)', () => {
  it('is 5', () => {
    expect(RENDER_CAP).toBe(5);
  });

  it('shows everything with moreCount 0 when at or under the cap', () => {
    const entries = [1, 2, 3];
    expect(capEntriesForRender(entries)).toEqual({ shown: [1, 2, 3], moreCount: 0 });
  });

  it('caps at RENDER_CAP and reports the remainder as moreCount', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7];
    expect(capEntriesForRender(entries)).toEqual({ shown: [1, 2, 3, 4, 5], moreCount: 2 });
  });
});

// Sanity: the two length-threshold constants are the exact values the extraction-rule doc states.
describe('extraction thresholds', () => {
  it('MIN_INLINE_CODE_SPAN_LENGTH is 6, MIN_QUOTED_STRING_LENGTH is 8', () => {
    expect(MIN_INLINE_CODE_SPAN_LENGTH).toBe(6);
    expect(MIN_QUOTED_STRING_LENGTH).toBe(8);
  });
});
