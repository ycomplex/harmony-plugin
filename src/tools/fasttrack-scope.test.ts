// B-1072 — unit coverage for the pure scope-guard (src/tools/fasttrack-scope.ts).

import { describe, it, expect } from 'vitest';
import { evaluateScopeBudget, isTestPath, parseNumstatLine, DEFAULT_SCOPE_BUDGET, type NumstatEntry } from './fasttrack-scope.js';

describe('evaluateScopeBudget', () => {
  it('a small diff within the default budget passes', () => {
    const entries: NumstatEntry[] = [
      { added: 10, deleted: 2, path: 'src/a.ts' },
      { added: 5, deleted: 0, path: 'src/b.ts' },
    ];
    const result = evaluateScopeBudget(entries);
    expect(result).toEqual({
      withinBudget: true,
      filesChanged: 2,
      testFilesIgnored: 0,
      linesChanged: 17,
      budget: DEFAULT_SCOPE_BUDGET,
    });
  });

  it('a diff over the file-count budget fails, even with few lines each', () => {
    const entries: NumstatEntry[] = Array.from({ length: 6 }, (_, i) => ({
      added: 1,
      deleted: 0,
      path: `src/file${i}.ts`,
    }));
    const result = evaluateScopeBudget(entries);
    expect(result.filesChanged).toBe(6);
    expect(result.withinBudget).toBe(false);
  });

  it('a diff over the line-count budget fails, even with few files', () => {
    const entries: NumstatEntry[] = [{ added: 200, deleted: 0, path: 'src/a.ts' }];
    const result = evaluateScopeBudget(entries);
    expect(result.linesChanged).toBe(200);
    expect(result.withinBudget).toBe(false);
  });

  it('a binary file entry contributes 0 lines but still counts as a changed file', () => {
    const entries: NumstatEntry[] = [
      { added: null, deleted: null, path: 'assets/logo.png' },
      { added: 3, deleted: 1, path: 'src/a.ts' },
    ];
    const result = evaluateScopeBudget(entries);
    expect(result.filesChanged).toBe(2);
    expect(result.linesChanged).toBe(4);
    expect(result.withinBudget).toBe(true);
  });

  it('a custom (non-default) budget is honored', () => {
    const entries: NumstatEntry[] = [
      { added: 50, deleted: 10, path: 'src/a.ts' },
      { added: 20, deleted: 5, path: 'src/b.ts' },
    ];
    const tightBudget = { files: 1, lines: 1000 };
    const result = evaluateScopeBudget(entries, tightBudget);
    expect(result.withinBudget).toBe(false); // 2 files > budget of 1
    expect(result.budget).toEqual(tightBudget);

    const looseBudget = { files: 10, lines: 10 };
    const result2 = evaluateScopeBudget(entries, looseBudget);
    expect(result2.withinBudget).toBe(false); // 85 lines > budget of 10
  });
});

describe('parseNumstatLine', () => {
  it('parses an ordinary added/deleted/path line', () => {
    expect(parseNumstatLine('10\t2\tsrc/a.ts')).toEqual({ added: 10, deleted: 2, path: 'src/a.ts' });
  });

  it('parses a binary file line ("-\\t-\\tpath") to null added/deleted', () => {
    expect(parseNumstatLine('-\t-\tassets/logo.png')).toEqual({ added: null, deleted: null, path: 'assets/logo.png' });
  });

  it('returns null for a blank line', () => {
    expect(parseNumstatLine('')).toBeNull();
    expect(parseNumstatLine('   ')).toBeNull();
  });

  it('preserves a tab-containing path by rejoining remaining parts', () => {
    expect(parseNumstatLine('1\t1\tsrc/weird\tname.ts')).toEqual({ added: 1, deleted: 1, path: 'src/weird\tname.ts' });
  });
});

// B-1109 — test files never count toward the budget.
describe('B-1109: test files are excluded from the scope budget', () => {
  it('isTestPath recognises the shapes this project uses', () => {
    for (const p of [
      'src/tools/fasttrack-scope.test.ts',
      'src/features/x/Y.spec.tsx',
      'e2e/tests/task-decomposition.spec.ts',
      'e2e/fixtures/test.ts',
      'supabase/tests/b1091_workspace_member_limit.test.sql',
      'src/__tests__/helpers.ts',
    ]) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/tools/fasttrack-scope.ts', 'src/pages/WorkspaceSettings.tsx', 'scripts/test-b1091-workspace-member-limit-db.sh', 'docs/testing.md']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it("B-1090's shape — 7 files / 223 lines with 2 test files — counts as 5 source files and passes a 5/150 budget only on files, not lines", () => {
    const entries = [
      { added: 1, deleted: 0, path: 'src/features/conductors/components/CompletedConductionsTab.test.tsx' },
      { added: 1, deleted: 1, path: 'src/features/conductors/components/CompletedConductionsTab.tsx' },
      { added: 4, deleted: 3, path: 'src/features/conductors/components/ConductorsTable.tsx' },
      { added: 60, deleted: 34, path: 'src/features/conductors/components/LegCostDisclosure.test.tsx' },
      { added: 52, deleted: 35, path: 'src/features/conductors/components/LegCostDisclosure.tsx' },
      { added: 4, deleted: 2, path: 'src/features/conductors/hooks/useCompletedConductions.ts' },
      { added: 21, deleted: 5, path: 'src/features/tasks/components/ConductorControl.tsx' },
    ];
    const r = evaluateScopeBudget(entries);
    expect(r.testFilesIgnored).toBe(2);
    expect(r.filesChanged).toBe(5);
    expect(r.linesChanged).toBe(128);
    expect(r.withinBudget).toBe(true);
  });

  it('a diff that is ONLY tests changes nothing against the budget', () => {
    const r = evaluateScopeBudget([
      { added: 400, deleted: 0, path: 'src/a.test.ts' },
      { added: 90, deleted: 10, path: 'e2e/tests/b.spec.ts' },
    ]);
    expect(r).toMatchObject({ filesChanged: 0, linesChanged: 0, testFilesIgnored: 2, withinBudget: true });
  });

  it('an ordinary source-only diff reports zero ignored test files', () => {
    expect(evaluateScopeBudget([{ added: 3, deleted: 1, path: 'src/a.ts' }]).testFilesIgnored).toBe(0);
  });
});
