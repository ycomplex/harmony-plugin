// B-1037 — unit coverage for AC4's sanitizer (evals/clarify-replay/scripts/sanitize-eval-result.mjs),
// which strips grader criteria/graderMarkdown/config.criteria before a CI artifact upload. This is
// the FIRST of two enforcement layers (the CI workflow's own marker-heading grep on the output is
// the second, proof layer — see the proposed workflow YAML).

import { describe, it, expect } from 'vitest';
import {
  sanitizeEvalResult,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs helper module, deliberately dependency-free and untyped
} from '../evals/clarify-replay/scripts/sanitize-eval-result.mjs';

describe('sanitizeEvalResult', () => {
  it('strips criteria and graderMarkdown at the top level of a grader object', () => {
    const input = { name: 'judge', criteria: '## THE RATIFIED LABEL — B-1: x', graderMarkdown: 'more label text', score: 1 };
    const out = sanitizeEvalResult(input);
    expect(out).toEqual({ name: 'judge', score: 1 });
  });

  it('strips criteria nested under config', () => {
    const input = { name: 'judge', config: { criteria: '## THE RATIFIED LABEL — B-1: x', weight: 4 } };
    const out = sanitizeEvalResult(input);
    expect(out).toEqual({ name: 'judge', config: { weight: 4 } });
  });

  it('strips recursively through arrays of cases/graders, preserving everything else', () => {
    const input = {
      overallScore: 0.9,
      casesPassed: 14,
      costUsd: 1.23,
      cases: [
        {
          name: 'B-293',
          graders: [
            { name: 'frame-sections-present', weight: 2, passed: true },
            { name: 'judge', type: 'llm', criteria: '## THE RATIFIED LABEL — B-293: x', graderMarkdown: 'label text', score: 1 },
          ],
        },
      ],
    };
    const out = sanitizeEvalResult(input);
    expect(out.overallScore).toBe(0.9);
    expect(out.casesPassed).toBe(14);
    expect(out.costUsd).toBe(1.23);
    expect(out.cases[0].graders[0]).toEqual({ name: 'frame-sections-present', weight: 2, passed: true });
    expect(out.cases[0].graders[1]).toEqual({ name: 'judge', type: 'llm', score: 1 });
    expect(JSON.stringify(out)).not.toContain('THE RATIFIED LABEL');
  });

  it('leaves a result with no grader-secret fields untouched', () => {
    const input = { overallScore: 1, casesPassed: 2, nested: { a: [1, 2, { b: 'ok' }] } };
    expect(sanitizeEvalResult(input)).toEqual(input);
  });

  it('handles primitives and null passthrough', () => {
    expect(sanitizeEvalResult(null)).toBeNull();
    expect(sanitizeEvalResult(5)).toBe(5);
    expect(sanitizeEvalResult('x')).toBe('x');
  });
});
