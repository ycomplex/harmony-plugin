// B-1452: the shared token-shape list (stop-gate safeRef + raise_incident).
import { describe, expect, it } from 'vitest';
import { containsTokenShape, scrubTokenShapes, TOKEN_SHAPES } from './token-shapes.js';

// Built at runtime so this source file carries no literal token shape.
const j = (...p: string[]) => p.join('');
const SAMPLES: Record<string, string> = {
  github: j('gh', 'p_', 'abcdEFGH1234'),
  'github-pat': j('github', '_pat_', '11AAAA_bbbb'),
  'sk-key': j('s', 'k-', 'proj-abc123'),
  jwt: j('ey', 'Jhb', 'GciOi.eyJzdWIi.sig'),
  slack: j('xo', 'xb-', '1234-5678-abcd'),
  aws: j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  figma: j('fi', 'gd_', 'abc-DEF_123'),
  google: j('AI', 'za', 'A'.repeat(35)),
  'private-key': j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'long-run': 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7',
};

describe('token shapes', () => {
  it('exports one named list', () => {
    expect(TOKEN_SHAPES.map((s) => s.name)).toContain('github');
    expect(TOKEN_SHAPES[TOKEN_SHAPES.length - 1].name).toBe('long-base64-run');
  });

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`detects and scrubs a ${name} shape inside prose`, () => {
      const text = `before ${sample} after`;
      expect(containsTokenShape(text)).toBe(true);
      const out = scrubTokenShapes(text);
      expect(out).not.toContain(sample);
      expect(out).toMatch(/^before .*\[redacted\].* after$/);
    });
  }

  it('scrubs the whole token, not just its prefix, and is idempotent', () => {
    const t = j('gh', 's_', 'Zz9'.repeat(12));
    expect(scrubTokenShapes(`x=${t};`)).toBe('x=[redacted];');
    expect(scrubTokenShapes(scrubTokenShapes(`x=${t};`))).toBe('x=[redacted];');
  });

  it('leaves ordinary text alone (low false positives)', () => {
    for (const ok of [
      'risk-free change on feat/B-1452-incident-raise',
      'commit 1a2b3c4 on branch main',
      'pr#42-checks',
      'https://github.com/ycomplex/harmony-plugin/pull/519',
      'claude-code:opus-5.5',
      'revoke and rotate the token, then rewrite history',
      'the task-sketch skill',
    ]) {
      expect(containsTokenShape(ok), ok).toBe(false);
      expect(scrubTokenShapes(ok)).toBe(ok);
    }
  });

  it('never throws on a non-string', () => {
    expect(containsTokenShape(undefined as unknown as string)).toBe(false);
    expect(scrubTokenShapes(null as unknown as string)).toBe('');
  });
});
