// B-1072 — unit coverage for the pure scope-guard (src/tools/fasttrack-scope.ts).

import { describe, it, expect } from 'vitest';
import { evaluateScopeBudget, parseNumstatLine, DEFAULT_SCOPE_BUDGET, type NumstatEntry } from './fasttrack-scope.js';

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
