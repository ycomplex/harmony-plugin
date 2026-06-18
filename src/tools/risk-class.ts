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
// DESIGN BIAS: CONSERVATIVE. This is a safety floor, so it deliberately
// OVER-detects — a false positive costs one human glance; a false negative lets
// a delegated agent silently auto-advance an auth/migration/destructive change.
// Word-boundary, case-insensitive matching keeps the over-detection from being
// absurd (we don't want "author" to trip `auth`), but when in doubt we trip.
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
// ---------------------------------------------------------------------------
const KEYWORD_TABLE: Record<RiskClass, RegExp[]> = {
  auth: [
    // auth / login / logout / session / token / password / oauth / RLS / permission / role
    /\bauth(?:entication|orization|z|n)?\b/i,
    /\boauth\b/i,
    /\blog[\s-]?in\b/i,
    /\blog[\s-]?out\b/i,
    /\bsign[\s-]?in\b/i,
    /\bsign[\s-]?out\b/i,
    /\bsession\b/i,
    /\btokens?\b/i,
    /\bpasswords?\b/i,
    /\bcredentials?\b/i,
    /\bRLS\b/i,
    /\brow[\s-]?level[\s-]?security\b/i,
    /\bpermissions?\b/i,
    /\broles?\b/i,
  ],
  'data-migration': [
    // migration / schema / ALTER TABLE / backfill / DROP COLUMN
    /\bmigrations?\b/i,
    /\bschema\b/i,
    /\balter\s+table\b/i,
    /\badd\s+column\b/i,
    /\bdrop\s+column\b/i,
    /\bbackfill(?:s|ed|ing)?\b/i,
    /\bdata[\s-]?migration\b/i,
  ],
  'irreversible-destructive': [
    // DROP / DELETE FROM / TRUNCATE / irreversible / hard-delete / purge
    /\bdrop\s+(?:table|column|database|schema|index|constraint)\b/i,
    /\bdelete\s+from\b/i,
    /\btruncate\b/i,
    /\birreversible\b/i,
    /\bhard[\s.-]?delete(?:s|d)?\b/i,
    /\bpurge(?:s|d|ing)?\b/i,
    /\bdestructive\b/i,
    /\bunrecoverable\b/i,
    /\bpermanently\s+(?:delete|remove|destroy)/i,
  ],
  'shared-core': [
    // curated shared module names that, if touched, have broad blast radius
    /\bsupabase\.ts\b/i,
    /\bauth\.ts\b/i,
    /\bsrc\/tools\/registry\b/i,
    /\bsrc\/tools\/index\.ts\b/i,
    /\bregisterTools\b/i,
    /\bshared[\s-]?core\b/i,
  ],
};

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

/** Convert a single glob (supporting `**`, `*`, `?`) into an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
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

/**
 * DETERMINISTIC risk-class detection. Returns the sorted, de-duplicated set of
 * RiskClasses the input touches. Pure — never throws on malformed input, and an
 * empty/whitespace input returns `[]` (a clean gate). Conservative by design:
 * a class trips if ANY of its keyword regexes match the text, OR any of its path
 * globs match a changed path, OR an explicit label names it.
 */
export function detectRiskClasses(input: DetectRiskInput): RiskClass[] {
  const hits = new Set<RiskClass>();
  const text = typeof input.text === 'string' ? input.text : '';
  const paths = Array.isArray(input.changedPaths) ? input.changedPaths.filter((p) => typeof p === 'string') : [];
  const labels = Array.isArray(input.labels) ? input.labels.filter((l) => typeof l === 'string') : [];

  // 1. Explicit label override — force-trips the named class regardless of text/paths.
  for (const label of labels) {
    const cls = labelToRiskClass(label);
    if (cls) hits.add(cls);
  }

  // 2. Keyword matching over the text.
  if (text.length > 0) {
    for (const cls of RISK_CLASSES) {
      if (KEYWORD_TABLE[cls].some((re) => re.test(text))) hits.add(cls);
    }
  }

  // 3. Path-glob matching over the changed paths.
  if (paths.length > 0) {
    for (const cls of RISK_CLASSES) {
      const globs = PATH_REGEX_TABLE[cls];
      if (globs.length > 0 && paths.some((p) => globs.some((re) => re.test(p)))) hits.add(cls);
    }
  }

  // Return in canonical class order for stable, snapshot-friendly output.
  return RISK_CLASSES.filter((cls) => hits.has(cls));
}
