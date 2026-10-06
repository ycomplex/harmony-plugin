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
  filesChanged: number;
  linesChanged: number;
  budget: ScopeBudget;
}

/** Pure — takes already-parsed `git diff --numstat` rows (added<TAB>deleted<TAB>path per file) and a
 *  budget, returns whether the change fits. Total churn = sum of added+deleted across all files
 *  (binary files contribute 0 lines but still count as a changed file). Never shells out itself —
 *  the caller runs `git diff --numstat` and parses rows into NumstatEntry[]. */
export function evaluateScopeBudget(entries: NumstatEntry[], budget: ScopeBudget = DEFAULT_SCOPE_BUDGET): ScopeEvaluation {
  const filesChanged = entries.length;
  const linesChanged = entries.reduce((sum, e) => sum + (e.added ?? 0) + (e.deleted ?? 0), 0);
  return {
    withinBudget: filesChanged <= budget.files && linesChanged <= budget.lines,
    filesChanged,
    linesChanged,
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
