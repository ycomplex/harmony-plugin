// B-1072 — the pure scope-guard the harmony-fasttrack skill's Build phase refuses PR-open on, and
// B-1073's daemon leg will import directly (no second eligibility/budget rule — see the ticket).

export interface ScopeBudget {
  files: number;
  lines: number;
}

export const DEFAULT_SCOPE_BUDGET: ScopeBudget = { files: 5, lines: 150 };

export interface NumstatEntry {
  /** Lines added, or null for a binary file (git diff --numstat prints `-` for binary). */
  added: number | null;
  deleted: number | null;
  path: string;
}

export interface ScopeEvaluation {
  withinBudget: boolean;
  /** Non-test files changed — test files never count (B-1109). */
  filesChanged: number;
  /** Non-test churn (added + deleted) — test files never count (B-1109). */
  linesChanged: number;
  /** B-1109: test files present in the diff but excluded from both counts, so the verdict can say
   *  "7 files, 2 of them tests" rather than hiding what it ignored. */
  testFilesIgnored: number;
  budget: ScopeBudget;
}

/** B-1109 — is this path a test? The guard is the floor against a one-sentence change that GROWS
 *  (B-698); a change that adds or extends tests is doing the right thing and must not be refused for
 *  it. B-1090 was refused at 7 files / 223 lines where 2 files and ~95 lines were test churn — the
 *  source change was inside the budget. Covers the test shapes this project's repos use: co-located
 *  `*.test.*` / `*.spec.*`, Playwright specs under `e2e/`, SQL invariant suites under
 *  `supabase/tests/`, and any `__tests__/` directory. */
export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (/(^|\/)(e2e|__tests__)\//.test(p)) return true;
  if (/(^|\/)supabase\/tests\//.test(p)) return true;
  return /\.(test|spec)\.[A-Za-z0-9]+$/.test(p);
}

/** Pure — takes already-parsed `git diff --numstat` rows (added<TAB>deleted<TAB>path per file) and a
 *  budget, returns whether the change fits. Total churn = sum of added+deleted across the NON-TEST
 *  files (binary files contribute 0 lines but still count as a changed file; test files are excluded
 *  from both counts and reported as `testFilesIgnored`, B-1109). Never shells out itself — the caller
 *  runs `git diff --numstat` and parses rows into NumstatEntry[]. */
export function evaluateScopeBudget(entries: NumstatEntry[], budget: ScopeBudget = DEFAULT_SCOPE_BUDGET): ScopeEvaluation {
  const counted = entries.filter((e) => !isTestPath(e.path));
  const filesChanged = counted.length;
  const linesChanged = counted.reduce((sum, e) => sum + (e.added ?? 0) + (e.deleted ?? 0), 0);
  return {
    withinBudget: filesChanged <= budget.files && linesChanged <= budget.lines,
    filesChanged,
    linesChanged,
    testFilesIgnored: entries.length - counted.length,
    budget,
  };
}

/** Parses one `git diff --numstat` line into a NumstatEntry. Exported so the skill (or a test) can
 *  feed real `git diff --numstat` output straight through. A binary file's `-\t-\tpath` parses to
 *  `{ added: null, deleted: null, path }`. */
export function parseNumstatLine(line: string): NumstatEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [addedRaw, deletedRaw, ...pathParts] = trimmed.split('\t');
  const path = pathParts.join('\t');
  const added = addedRaw === '-' ? null : Number(addedRaw);
  const deleted = deletedRaw === '-' ? null : Number(deletedRaw);
  return { added: Number.isFinite(added) ? added : null, deleted: Number.isFinite(deleted) ? deleted : null, path };
}
