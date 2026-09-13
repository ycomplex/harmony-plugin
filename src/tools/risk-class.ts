// ===========================================================================
// CONDUCTOR RISK-CLASS FLOOR (B-493 phase 2c).
//
// A DETERMINISTIC, MECHANICAL detector — NOT an LLM/semantic judgment. Given a
// ticket's text (title/description + active brief/decision content), an optional
// list of changed file paths, and any explicit risk labels, it returns the set
// of high-consequence "risk classes" the work touches.
//
// In the conductor (harmony-conduct) this is the NON-DISCRETIONARY FLOOR that
// sits UNDERNEATH the per-run delegation mode and the trust dial: before
// auto-advancing ANY delegated gate, the conductor reads `risk_classes`; if the
// set is non-empty it surfaces + pauses + ANNOUNCES which class tripped it —
// regardless of mode, dial level, or agent judgment (mirrors how release/verify
// are non-discretionary). A risk-class hit floors even a gate judged "routine"
// by the --escalate judgment.
//
// DESIGN BIAS: CONSERVATIVE-ON-AMBIGUITY. This is a safety floor, so it
// deliberately OVER-detects — a false positive costs one human glance; a false
// negative lets a delegated agent silently auto-advance an auth/migration/
// destructive change. Word-boundary, case-insensitive matching keeps the
// over-detection from being absurd (we don't want "author" to trip `auth`), but
// when in doubt we trip.
//
// B-516 SCOPE-AWARENESS (still deterministic, NO LLM): three mechanical filters
// trim the *clear* false-positives without weakening the floor on ambiguity —
// (1) NEGATION-SCOPING (a clearly-negated keyword hit doesn't count, e.g. "no
// migration") over a preceding window (B-889: widened 4→6 tokens), bounded by a
// HARD clause boundary (but/then/so/yet — always stops the scan) or a LIST
// CONNECTOR (and/or — stops the scan too, UNLESS the word right after it opens a
// genuinely new clause's subject, e.g. "it"/"this"/"there", in which case the
// connector is crossed so a single shared negation can still reach an earlier
// keyword); (2) WORD-SENSE TIGHTENING (a thin keyword like `token` counts for
// `auth` only in the auth sense, never the state-machine "gate token" sense;
// B-889 adds two more — `migrations?` is rejected when immediately followed by a
// PR/pull-request noun (CI-trigger-condition prose, not a schema change), and
// `credentials?`/`session`/`tokens?`/`permissions?` are rejected near a
// READING-qualifier word like "existing"/"under" UNLESS an authoring verb like
// add/create/change/implement/require is also nearby); and (3) a BUILD-GATE
// DOWN-WEIGHT (a prose-only hit is demoted when a real diff is present and
// touches none of the class's path-globs). Each suppresses ONLY a clear negation
// / wrong sense / clean-diff contradiction; on ANY ambiguity the class still
// trips. The down-weight fires only with a real diff (discovery gates pass no
// paths), so absence-of-diff never suppresses.
//
// This file is intentionally dependency-free and pure so it is trivially unit
// testable (mirrors src/tools/trust-model.ts) and reusable by the MCP get_task
// handler (text + active brief) and the build gate (text + `git diff --name-only`).
// ===========================================================================

export type RiskClass = 'auth' | 'data-migration' | 'irreversible-destructive' | 'shared-core';

export const RISK_CLASSES: RiskClass[] = [
  'auth',
  'data-migration',
  'irreversible-destructive',
  'shared-core',
];

export interface DetectRiskInput {
  /** Free text to scan — ticket title + description, active brief/decision content, etc. */
  text?: string;
  /** Optional changed file paths (e.g. `git diff --name-only` output) for path-glob matching. */
  changedPaths?: string[];
  /** Explicit risk labels — an override that force-trips the named class regardless of text/paths. */
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Per-class KEYWORD tables (scanned against `text`).
//
// Each entry is a case-insensitive, word-boundary regex. `\b` boundaries keep
// the conservative bias from going absurd: `auth` trips on "auth"/"OAuth" but
// not on "author"; `DROP` trips on "DROP TABLE" but not on "dropdown". The
// starting points come straight from the B-493 spec; tuned only to avoid the
// obvious false positives while keeping the over-detection bias.
//
// B-516 — SCOPE-AWARENESS (still deterministic, NO LLM, conservative-on-ambiguity):
// keyword hits are now passed through two mechanical scope filters before they
// count (see `matchesClass` below):
//   1. NEGATION-SCOPING — a hit whose short preceding token window contains a
//      negation cue (`no`/`not`/`without`/`n't`/`zero`/`neither`/`nor`, incl.
//      repeated "no … no …") does NOT count. Suppresses ONLY on a CLEAR negation;
//      anything ambiguous still fires (a false negative is the failure the floor
//      exists to catch). Repro: "no schema/RPC/DB, no MCP, no migration" → no
//      `data-migration`.
//   2. WORD-SENSE TIGHTENING — thin keywords carry a per-keyword sense guard
//      (`senseOk`). Tuned so far (evidence-driven, minimal):
//        - the `token` keyword counts for `auth` ONLY when an auth qualifier sits
//          adjacent (`auth|access|api|bearer|jwt|session|refresh|csrf`). The
//          state-machine sense (`gate token` / `state token` / `workflow_state
//          token`) carries no qualifier, so it returns false on its own — no
//          separate veto needed. A present auth qualifier WINS
//          (conservative-on-ambiguity). Repro: "workflow_state gate token" → no
//          `auth`; "bearer token in the gate handler" → `auth`.
//        - (B-889) `migrations?` is rejected when the very next word is a
//          PR/pull-request noun — CI-trigger-condition prose ("a migration PR",
//          "non-migration PRs") describing WHICH PRs a workflow runs on, not an
//          actual schema migration. See `MIGRATION_CI_TRIGGER_QUALIFIER`.
//        - (B-889) `credentials?`/`session`/`tokens?`/`permissions?` are
//          rejected near a READING-qualifier word (existing/current/exercised/
//          accessed/observed/inside/under) — text merely OBSERVING an existing
//          auth surface, not authoring a new one — UNLESS an authoring verb
//          (add/create/change/implement/require) also sits nearby, which WINS
//          (conservative-on-ambiguity). See `notReadingQualifiedSense`. `tokens?`
//          layers this ON TOP of its existing auth-qualifier guard — both must
//          pass.
// ---------------------------------------------------------------------------

/** A keyword entry: a word-boundary regex plus an optional per-keyword word-sense guard.
 *  `senseOk(text, matchStart, matchEnd)` returns false to REJECT an otherwise-matching hit
 *  (word-sense disambiguation). Omitted ⇒ the keyword always counts (subject only to negation). */
interface Keyword {
  re: RegExp;
  senseOk?: (text: string, start: number, end: number) => boolean;
}

const kw = (re: RegExp, senseOk?: Keyword['senseOk']): Keyword => ({ re, senseOk });

// Word-sense guard for the thin `token` keyword (B-516, repro Ev1c; hardened B-516-review).
// `token` is too generic to trip `auth` on its own — Harmony's own domain uses "gate token" /
// "workflow_state token" (state-machine senses). So `token` counts for `auth` ONLY when an
// auth qualifier sits adjacent to it.
//
// CONSERVATIVE-ON-AMBIGUITY (review fix): a PRESENT auth qualifier WINS. The previous version
// ran a state-machine veto BEFORE the qualifier check, so a genuine auth concern that merely
// sat near "gate"/"state" got killed (e.g. "validate the bearer token in the gate handler" →
// no auth — a false negative the safety floor exists to catch). The auth qualifier is now
// sufficient: with no qualifier a bare / "gate" / "state" token already returns false (the
// state-machine senses carry no qualifier), so dropping the unconditional veto re-fires the
// real auth tokens while keeping every Ev1c state-machine case green.
const AUTH_TOKEN_QUALIFIER = /\b(?:auth|access|api|bearer|jwt|session|refresh|csrf)\b/i;
function tokenIsAuthSense(text: string, start: number, end: number): boolean {
  // Look at a tight window on BOTH sides of the `token` hit (qualifiers like
  // "auth token" precede; "token refresh" can follow). ~24 chars ≈ 3-4 words.
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 24);
  const window = before + ' ' + after;
  // A present auth qualifier is SUFFICIENT (and necessary) for the auth sense.
  return AUTH_TOKEN_QUALIFIER.test(window);
}

// Word-sense guard for the `migrations?` keyword (B-889, repro: Playwright/web E2E CI-trigger
// prose). "on a migration PR" / "on non-migration PRs" describes WHICH PRs a CI workflow runs on
// — a CI-trigger condition, not an actual schema migration. Tight ADJACENCY only (the very next
// word, not a wide window): a genuine migration mention that merely happens to be near an
// unrelated "PR" further away (e.g. "ship a migration before merging this PR") must still count.
const MIGRATION_CI_TRIGGER_QUALIFIER = /^\s*(?:PRs?|pull[\s-]?requests?)\b/i;
function migrationSenseOk(text: string, _start: number, end: number): boolean {
  // Only the immediate next word after the match — "immediately followed by", not "near".
  const after = text.slice(end, end + 20);
  return !MIGRATION_CI_TRIGGER_QUALIFIER.test(after);
}

// Word-sense guard for the thin `credentials?`/`session`/`tokens?`/`permissions?` keywords
// (B-889, repro: B-930 "has not been exercised from inside a worker's credentials"; B-936 the
// same ticket text read twice producing an unstable class set). These keywords also show up in
// prose merely READING/observing an existing auth surface ("the existing session", "current
// permissions", "exercised from inside a worker's credentials") rather than authoring a NEW one.
// An authoring-verb signal (add/create/change/implement/require) nearby is
// CONSERVATIVE-ON-AMBIGUITY: it WINS and the hit stands even next to a reading-qualifier word;
// only in ITS ABSENCE does a nearby reading-qualifier reject the hit.
const AUTH_AUTHORING_VERBS =
  /\b(?:add(?:s|ed|ing)?|creat(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|implement(?:s|ed|ing)?|requir(?:e|es|ed|ing))\b/i;
const READING_QUALIFIER_WORDS = /\b(?:existing|current|exercised|accessed|observed|inside|under)\b/i;
// Wider than AUTH_TOKEN_QUALIFIER's ~24 chars — reading-qualifier words like "exercised" / "inside"
// often sit further back ("has not been exercised from inside a worker's credentials" is ~6 words
// of preceding context).
const READING_QUALIFIER_WINDOW = 56;
function notReadingQualifiedSense(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - READING_QUALIFIER_WINDOW), start);
  const after = text.slice(end, end + READING_QUALIFIER_WINDOW);
  const window = before + ' ' + after;
  if (AUTH_AUTHORING_VERBS.test(window)) return true; // an authoring signal WINS — conservative-on-ambiguity
  return !READING_QUALIFIER_WORDS.test(window);
}

const KEYWORD_TABLE: Record<RiskClass, Keyword[]> = {
  auth: [
    // auth / login / logout / session / token / password / oauth / RLS / permission / role
    kw(/\bauth(?:entication|orization|z|n)?\b/i),
    kw(/\boauth\b/i),
    kw(/\blog[\s-]?in\b/i),
    kw(/\blog[\s-]?out\b/i),
    kw(/\bsign[\s-]?in\b/i),
    kw(/\bsign[\s-]?out\b/i),
    kw(/\bsession\b/i, notReadingQualifiedSense),
    kw(/\btokens?\b/i, (text, start, end) => tokenIsAuthSense(text, start, end) && notReadingQualifiedSense(text, start, end)),
    kw(/\bpasswords?\b/i),
    kw(/\bcredentials?\b/i, notReadingQualifiedSense),
    kw(/\bRLS\b/i),
    kw(/\brow[\s-]?level[\s-]?security\b/i),
    kw(/\bpermissions?\b/i, notReadingQualifiedSense),
    kw(/\broles?\b/i),
  ],
  'data-migration': [
    // migration / schema / ALTER TABLE / backfill / DROP COLUMN
    kw(/\bmigrations?\b/i, migrationSenseOk),
    kw(/\bschema\b/i),
    kw(/\balter\s+table\b/i),
    kw(/\badd\s+column\b/i),
    kw(/\bdrop\s+column\b/i),
    kw(/\bbackfill(?:s|ed|ing)?\b/i),
    kw(/\bdata[\s-]?migration\b/i),
  ],
  'irreversible-destructive': [
    // DROP / DELETE FROM / TRUNCATE / irreversible / hard-delete / purge
    kw(/\bdrop\s+(?:table|column|database|schema|index|constraint)\b/i),
    kw(/\bdelete\s+from\b/i),
    kw(/\btruncate\b/i),
    kw(/\birreversible\b/i),
    kw(/\bhard[\s.-]?delete(?:s|d)?\b/i),
    kw(/\bpurge(?:s|d|ing)?\b/i),
    kw(/\bdestructive\b/i),
    kw(/\bunrecoverable\b/i),
    kw(/\bpermanently\s+(?:delete|remove|destroy)/i),
  ],
  'shared-core': [
    // curated shared module names that, if touched, have broad blast radius
    kw(/\bsupabase\.ts\b/i),
    kw(/\bauth\.ts\b/i),
    kw(/\bsrc\/tools\/registry\b/i),
    kw(/\bsrc\/tools\/index\.ts\b/i),
    kw(/\bregisterTools\b/i),
    kw(/\bshared[\s-]?core\b/i),
  ],
};

// ---------------------------------------------------------------------------
// NEGATION-SCOPING (B-516, hardened B-516-review, widened B-889). For a keyword
// hit, scan a short PRECEDING token window (B-889: widened 4→6 tokens) for a
// negation cue. Deterministic; conservative-on-ambiguity — it suppresses ONLY a
// clearly-negated hit.
//
// Cues: `no`, `not`, `without`, an `n't` contraction (don't/won't/can't…),
// `zero`, and `neither`/`nor`/`none`.
//
// CLAUSE-BOUNDARY BOUND (review fix; split B-889): the backward scan STOPS at a
// clause boundary — a comma / semicolon / colon / period, an em/en dash or a
// spaced hyphen-dash, or a HARD coordinating conjunction (`but`/`then`/`so`/
// `yet` — these ALWAYS stop the scan, no exception). A LIST CONNECTOR
// (`and`/`or`) is different: it stops the scan too, UNLESS the word immediately
// after it (i.e. the token just consumed, closer to the keyword) is a
// SUBJECT-STARTER word (`it`/`this`/`that`/`we`/`you`/`they`/`there`/`the`/`a`/
// `please`/`run`) — a clear signal that word opens a genuinely NEW clause's
// subject, so the connector still stops the scan. Otherwise the connector reads
// as a same-clause list item (e.g. "no X and Y") and is CROSSED so the scan
// keeps looking further back toward a shared negation cue. A cue only negates
// the keyword if it is reachable without crossing a HARD boundary or a
// clause-opening list connector.
//
// This kills the false-negative where a cue negates a DIFFERENT clause's
// subject, e.g. "with no downtime, run the migration" ('no' negates *downtime*,
// across the comma → the migration hit fires) and "There is no downtime and
// this migration must run before deploy" ('this' opens a new clause right after
// "and" → the migration hit fires); it also fixes the false-POSITIVE repro
// where a single shared "no" crosses a list connector over a non-subject-starter
// word, e.g. "This adds no client-side detector port and no tasks table
// migration" and "adds no client-side detector port and migration" (B-889) —
// both suppress `data-migration`, since "and" here is followed by a plain list
// item, not a new clause. The repeated "no schema, no migration" enumeration is
// unaffected: each item's OWN immediately-preceding `no` sits in the same
// clause as that item, so it still suppresses.
//
// HYPHEN-AWARE TOKENIZATION (review fix): an ASCII hyphen flanked by letters is
// INTRA-WORD, so `no-op` is ONE token (`no-op` ≠ the cue `no`) — "no-op guard;
// ALTER TABLE" no longer suppresses. A hyphen/dash that is NOT flanked by letters
// (a spaced " - " dash, or an em/en dash) is a clause boundary instead. Space-
// separated "no migration" still tokenizes to `['no','migration']`, so real
// negations are unaffected.
// ---------------------------------------------------------------------------
const NEGATION_CUES = new Set(['no', 'not', 'without', 'zero', 'neither', 'nor', 'none']);
const NEGATION_WINDOW = 6; // tokens of preceding context to scan (B-889: widened from 4)
// HARD clause-boundary tokens: a cue past one of these NEVER reaches the keyword — no exception.
const HARD_CLAUSE_BOUNDARY_TOKENS = new Set(['but', 'then', 'so', 'yet']);
// LIST-CONNECTOR tokens: same-clause list items ("no X and Y") share a single negation, so these
// are CROSSED rather than stopping the scan — UNLESS the word right after (closer to the keyword,
// i.e. the token most recently consumed) is a SUBJECT_STARTER_WORD, a clear signal the connector
// opens a genuinely NEW clause instead (see block comment above for the worked examples).
const LIST_CONNECTOR_TOKENS = new Set(['and', 'or']);
// Words that, appearing immediately after a LIST_CONNECTOR_TOKENS word (walking toward the
// keyword), mark the START of a new clause's subject — so the connector still stops the scan.
const SUBJECT_STARTER_WORDS = new Set([
  'it', 'this', 'that', 'we', 'you', 'they', 'there', 'the', 'a', 'please', 'run',
]);
// Punctuation that ends a clause (a cue past one of these does NOT reach the keyword).
// Includes em/en dashes; a bare ASCII hyphen is handled positionally (intra-word vs spaced dash).
const CLAUSE_BOUNDARY_PUNCT = /[,;:.–—]/;
const ASCII_LETTER = /[a-z]/; // (slice is lower-cased before scanning)

/**
 * Tokenize the preceding slice into lowercased word tokens, newest-first, STOPPING at the
 * first clause boundary (punctuation OR a HARD coordinating conjunction OR a clause-opening
 * LIST connector). A hyphen counts as intra-word (so `no-op` stays one token) ONLY when flanked
 * by letters; an unflanked hyphen or an em/en dash is a clause boundary. Returns at most
 * NEGATION_WINDOW in-clause tokens (a CROSSED list connector does not consume any of that budget).
 */
function precedingTokens(text: string, matchStart: number): string[] {
  // A generous char window (≈ NEGATION_WINDOW words plus room for crossed list connectors,
  // allowing for punctuation/parens).
  const slice = text.slice(Math.max(0, matchStart - 80), matchStart).toLowerCase();
  // True iff the char at index k is a word char: a letter / apostrophe, or an intra-word
  // ASCII hyphen (a hyphen with a letter on BOTH sides — `no-op`, not a spaced " - " dash).
  const isWordChar = (k: number): boolean => {
    const c = slice[k];
    if (c === undefined) return false;
    if (ASCII_LETTER.test(c) || c === "'") return true;
    if (c === '-') return ASCII_LETTER.test(slice[k - 1] ?? '') && ASCII_LETTER.test(slice[k + 1] ?? '');
    return false;
  };
  // Walk from the END backward; emit word-tokens but HALT at any clause boundary.
  const inClause: string[] = [];
  let i = slice.length - 1;
  while (i >= 0 && inClause.length < NEGATION_WINDOW) {
    if (CLAUSE_BOUNDARY_PUNCT.test(slice[i])) break; // comma/;/:/./em-/en-dash — stop scanning back
    if (isWordChar(i)) {
      // consume a whole word (run of word-chars) going backward
      let j = i;
      while (j >= 0 && isWordChar(j)) j--;
      const word = slice.slice(j + 1, i + 1);
      i = j;
      if (word.length === 0) continue;
      if (HARD_CLAUSE_BOUNDARY_TOKENS.has(word)) break; // always ends the scan — no exception
      if (LIST_CONNECTOR_TOKENS.has(word)) {
        // The token immediately after the connector (closer to the keyword) is the LAST one we
        // pushed. If it starts a new clause's subject, the connector stops the scan too;
        // otherwise it's a same-clause list item ("no X and Y") — cross it and keep scanning.
        const nextToward = inClause[inClause.length - 1];
        if (nextToward !== undefined && SUBJECT_STARTER_WORDS.has(nextToward)) break;
        continue; // crossed — the connector itself is not a negatable token
      }
      inClause.push(word);
    } else {
      // a non-word char that isn't boundary punctuation: whitespace, parens, slash, or a
      // spaced/unflanked ASCII hyphen-dash. A spaced hyphen-dash is a clause boundary; plain
      // whitespace/parens are not.
      if (slice[i] === '-') break; // unflanked hyphen acting as a dash — clause boundary
      i--; // whitespace / parens / slash / other inert punctuation — skip
    }
  }
  return inClause;
}

/** True iff the hit at [start) is clearly negated by a cue reachable in its short preceding,
 *  clause-bounded token window (the scan already stopped at any clause boundary). */
function isNegated(text: string, start: number): boolean {
  for (const tok of precedingTokens(text, start)) {
    if (NEGATION_CUES.has(tok)) return true;
    // `n't` contractions: don't / won't / can't / isn't / doesn't / shouldn't …
    if (tok.endsWith("n't")) return true;
  }
  return false;
}

/**
 * Does `text` trip `cls` on KEYWORD evidence, after scope filters? A class trips iff
 * at least ONE of its keywords has a match that is (a) word-sense-valid (`senseOk`) AND
 * (b) NOT clearly negated. Pure + allocation-light; scans each keyword's matches in order.
 */
function textHitsClass(text: string, cls: RiskClass): boolean {
  for (const keyword of KEYWORD_TABLE[cls]) {
    // Use a fresh global regex so we can walk every occurrence (the per-keyword
    // source regexes are non-global; clone with the `g` flag).
    const g = new RegExp(keyword.re.source, keyword.re.flags.includes('g') ? keyword.re.flags : keyword.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (m[0].length === 0) {
        g.lastIndex++; // guard against a zero-width match looping forever
        continue;
      }
      if (keyword.senseOk && !keyword.senseOk(text, start, end)) continue; // wrong sense → skip this hit
      if (isNegated(text, start)) continue; // clearly negated → skip this hit
      return true; // a clean, in-sense, un-negated hit ⇒ the class trips
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-class PATH-GLOB tables (matched against `changedPaths`).
//
// Globs are intentionally coarse — `**/auth/**` trips on any file under an
// `auth/` directory at any depth. We compile them once into anchored,
// case-insensitive regexes. The shared-core list is a CURATED set of high-blast
// modules; extend it as the shared surface grows.
// ---------------------------------------------------------------------------
const PATH_GLOB_TABLE: Record<RiskClass, string[]> = {
  auth: ['**/auth/**', '**/auth.ts', '**/auth.tsx', '**/*auth*.ts', '**/middleware/auth*', '**/rls/**'],
  'data-migration': ['**/migrations/**', '**/migration/**', '**/*.sql', '**/schema.sql', '**/supabase/migrations/**'],
  // No reliably-destructive path signature (destructiveness lives in content, not the path);
  // kept empty so this class trips on text/labels, never on an innocent path. The conservative
  // bias is served by the keyword table here, not by over-broad path globs.
  'irreversible-destructive': [],
  'shared-core': [
    '**/supabase.ts',
    '**/auth.ts',
    '**/src/tools/index.ts',
    '**/src/tools/registry*',
    '**/src/supabase.ts',
    '**/src/auth.ts',
  ],
};

/** Convert a single glob (supporting `**`, `*`, `?`) into an anchored, case-insensitive RegExp.
 *
 *  B-974 — EXPORTED (previously module-private) so the manifest's declared-evidence `applies_to.paths`
 *  matcher (src/config/manifest-evidence.ts) narrows by path with exactly this repo's ONE glob
 *  semantics rather than a second, subtly-different one. No behaviour change here, and no new
 *  dependency: the repo carries no glob library and B-974 deliberately does not add one. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches across path separators (any depth, incl. none)
        re += '.*';
        i++;
        // swallow a following slash so `**/foo` also matches a top-level `foo`
        if (glob[i + 1] === '/') i++;
      } else {
        // single `*` matches within a path segment (no separator)
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

// Pre-compile the path globs once at module load.
const PATH_REGEX_TABLE: Record<RiskClass, RegExp[]> = {
  auth: PATH_GLOB_TABLE.auth.map(globToRegExp),
  'data-migration': PATH_GLOB_TABLE['data-migration'].map(globToRegExp),
  'irreversible-destructive': PATH_GLOB_TABLE['irreversible-destructive'].map(globToRegExp),
  'shared-core': PATH_GLOB_TABLE['shared-core'].map(globToRegExp),
};

/** Normalize a free-form label into a known RiskClass, or null. Accepts the canonical class names
 *  plus common aliases (`risk:auth`, `migration`, `destructive`, `irreversible`, `core`). */
export function labelToRiskClass(label: string): RiskClass | null {
  const l = label.trim().toLowerCase().replace(/^risk[:/-]/, '');
  switch (l) {
    case 'auth':
      return 'auth';
    case 'data-migration':
    case 'migration':
    case 'data migration':
      return 'data-migration';
    case 'irreversible-destructive':
    case 'irreversible':
    case 'destructive':
      return 'irreversible-destructive';
    case 'shared-core':
    case 'shared core':
    case 'core':
      return 'shared-core';
    default:
      return null;
  }
}

/** A changed path matches `cls`'s path-globs. */
function pathHitsClass(paths: string[], cls: RiskClass): boolean {
  const globs = PATH_REGEX_TABLE[cls];
  return globs.length > 0 && paths.some((p) => globs.some((re) => re.test(p)));
}

/**
 * DETERMINISTIC, scope-aware risk-class detection (B-493, hardened B-516). Returns the
 * canonical-ordered, de-duplicated set of RiskClasses the input touches. Pure — never
 * throws on malformed input, and an empty/whitespace input returns `[]` (a clean gate).
 *
 * Conservative-on-ambiguity by design — a class trips if an explicit label names it, OR a
 * changed path matches its globs, OR a keyword hits its text AFTER the B-516 scope filters
 * (negation-scoping + word-sense tightening, see `textHitsClass`). The scope filters suppress
 * ONLY a clearly-negated or clearly-wrong-sense hit; any ambiguity still fires (a false
 * negative is the failure the floor exists to catch).
 *
 * BUILD-GATE down-weight (B-516, build gate ONLY): when `changedPaths` is NON-EMPTY (a real
 * diff is present) and it touches NONE of a class's path-globs, a PROSE-ONLY match for that
 * class is DEMOTED (not reported). This corrects the prose-keyed false-positive where a brief
 * merely *mentions* "migration" but the diff is, say, a single frontend file. It fires ONLY
 * with a real diff: at a discovery gate `changedPaths` is empty (absence-of-diff ≠ clean-diff),
 * so it never suppresses there. A label or a path hit is never down-weighted; only classes that
 * HAVE a path signature can be demoted (a class with no path-glob — irreversible-destructive —
 * has no clean-diff corroboration, so its prose hit always stands, keeping the floor protective).
 */
export function detectRiskClasses(input: DetectRiskInput): RiskClass[] {
  const hits = new Set<RiskClass>();
  const text = typeof input.text === 'string' ? input.text : '';
  const paths = Array.isArray(input.changedPaths) ? input.changedPaths.filter((p) => typeof p === 'string') : [];
  const labels = Array.isArray(input.labels) ? input.labels.filter((l) => typeof l === 'string') : [];
  const hasDiff = paths.length > 0;

  // 1. Explicit label override — force-trips the named class regardless of text/paths (never demoted).
  for (const label of labels) {
    const cls = labelToRiskClass(label);
    if (cls) hits.add(cls);
  }

  // 2. Path-glob matching over the changed paths (a real positive — never demoted).
  for (const cls of RISK_CLASSES) {
    if (pathHitsClass(paths, cls)) hits.add(cls);
  }

  // 3. Scope-aware keyword matching over the text, with the build-gate down-weight.
  if (text.length > 0) {
    for (const cls of RISK_CLASSES) {
      if (hits.has(cls)) continue; // already tripped by label or path — nothing to add
      if (!textHitsClass(text, cls)) continue; // no clean, in-sense, un-negated keyword hit
      // Build-gate down-weight: a prose-only hit is demoted when a real diff is present and
      // touches none of this class's path-globs. Only applies to classes WITH a path signature
      // (empty-glob classes have no clean-diff corroboration, so their prose hit always stands).
      const demotedByCleanDiff =
        hasDiff && PATH_GLOB_TABLE[cls].length > 0 && !pathHitsClass(paths, cls);
      if (!demotedByCleanDiff) hits.add(cls);
    }
  }

  // Return in canonical class order for stable, snapshot-friendly output.
  return RISK_CLASSES.filter((cls) => hits.has(cls));
}
