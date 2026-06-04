import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = readFileSync(
  join(process.cwd(), 'skills', 'harmony-shared', 'visual-handoff.md'),
  'utf8',
);

describe('visual-handoff shared discipline (B-328 D1/D2/D3)', () => {
  it('D1 — routing diagnostic + surface-form scaling + residue exception', () => {
    // F1: multi-word literals are \s+-tolerant so a linter reflow that wraps a phrase can't break the match.
    expect(DOC).toMatch(/glanceable\s+in\s+a\s+rendered\s+frame/i);
    expect(DOC.toLowerCase()).toContain('walk-through');
    expect(DOC.toLowerCase()).toContain('storyboard');
    expect(DOC).toMatch(/identity|motion|novel\s+visual\s+language/i);
    expect(DOC).toMatch(/not\s+whole\s+flows/i);
  });
  it('D2 — iterate loop is elicit-don\'t-guess + binds to the framed decision', () => {
    expect(DOC.toLowerCase()).toContain('elicit');
    expect(DOC).toMatch(/describe\s+the\s+alternative/i);
    expect(DOC).toMatch(/never\s+auto-generate/i);
    expect(DOC).toMatch(/framed\s+decision/i);
    expect(DOC).toMatch(/considered\s+decision|not\s+a\s+snap/i);
  });
  it('D3 — two-tier guard-rails + enumerative provenance + generation hygiene', () => {
    expect(DOC).toMatch(/generated\s+sketch/i);          // tier 1 — blanket banner
    expect(DOC.toLowerCase()).toContain('provenance');    // tier 2 — element-level
    for (const v of ['real', 'invented', 'illustrative']) {
      expect(DOC.toLowerCase()).toContain(v);
    }
    expect(DOC).toMatch(/enumerate/i);                    // F3 — name the invented elements, not just the legend
    expect(DOC).toMatch(/do\s+not\s+fabricate/i);
    expect(DOC).toMatch(/without\s+labelling/i);
  });
});
