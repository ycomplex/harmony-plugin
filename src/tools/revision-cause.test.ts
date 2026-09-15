import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVISION_CAUSE_SOURCES, isRevisionCause } from './revision-cause.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('isRevisionCause', () => {
  it('accepts a known source with string lines', () => {
    expect(isRevisionCause({ source: 'lint-self-review', lines: ['w'] })).toBe(true);
  });
  it('accepts every stored source', () => {
    for (const source of REVISION_CAUSE_SOURCES) {
      expect(isRevisionCause({ source, lines: [] }), source).toBe(true);
    }
  });
  it('rejects an unknown source, non-array lines, non-string lines, and non-objects', () => {
    expect(isRevisionCause({ source: 'nope', lines: [] })).toBe(false);
    expect(isRevisionCause({ source: 'self-review', lines: 'w' })).toBe(false);
    expect(isRevisionCause({ source: 'self-review', lines: [1] })).toBe(false);
    expect(isRevisionCause({ source: 'self-review' })).toBe(false);
    expect(isRevisionCause(null)).toBe(false);
    expect(isRevisionCause(undefined)).toBe(false);
    expect(isRevisionCause('self-review')).toBe(false);
  });
});

// The stored vocabulary lives in the web migration's CHECK. The plugin's mirror must equal it — read the
// migration FILE when harmony-web sits beside this checkout (same idiom as B-901's contract test).
//
// Path resolution: `HARMONY_WEB_ROOT` (an explicit web checkout — needed from a plugin worktree, where
// `../../../web` lands at `plugin/.worktrees/web`, which does not exist) else the workspace-sibling
// layout (`<workspace>/plugin/src/tools` -> `<workspace>/web`). Absent both, the mirror half SKIPS with
// the reason in the suite name; the guard tests above still run. It never silently passes.
const MIGRATION_FILE = '20260915160000_b1017_revision_cause.sql';
const MIGRATION = process.env.HARMONY_WEB_ROOT
  ? resolve(process.env.HARMONY_WEB_ROOT, 'supabase/migrations', MIGRATION_FILE)
  : resolve(__dirname, '../../../web/supabase/migrations', MIGRATION_FILE);
const present = existsSync(MIGRATION);
const suite = present ? describe : describe.skip;
const suiteName = present
  ? `REVISION_CAUSE_SOURCES mirrors the web CHECK (${MIGRATION_FILE})`
  : `SKIPPED — REVISION_CAUSE_SOURCES mirror: ${MIGRATION_FILE} not found at ${MIGRATION} (harmony-web is a ` +
    'separate repo; set HARMONY_WEB_ROOT to its checkout to run the mirror half)';
suite(suiteName, () => {
  it('lists exactly the sources the CHECK constraint allows', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const inList = sql.match(/revision_cause->>'source' in \(([\s\S]*?)\)/i)?.[1] ?? '';
    const fromSql = [...inList.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(fromSql.length).toBeGreaterThan(0); // positive control: the regex found the list
    expect([...REVISION_CAUSE_SOURCES].sort()).toEqual(fromSql);
  });
});
