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
  'figma-oauth': j('fi', 'gu_', 'abc-DEF_123'),
  google: j('AI', 'za', 'A'.repeat(35)),
  'private-key': j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'supabase-secret': j('sb', '_secret_', 'Ab3_x9-Qr7'),
  'harmony-api-token': j('harmony', '_', 'ab12'.repeat(16)),
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

  it('B-1305: names the Supabase secret key and Harmony API token shapes, ahead of the catch-all', () => {
    const names = TOKEN_SHAPES.map((s) => s.name);
    expect(names.indexOf('supabase-secret-key')).toBeGreaterThan(-1);
    expect(names.indexOf('harmony-api-token')).toBeGreaterThan(-1);
    expect(names.indexOf('supabase-secret-key')).toBeLessThan(names.indexOf('long-base64-run'));
    expect(names.indexOf('harmony-api-token')).toBeLessThan(names.indexOf('long-base64-run'));
    const sb = j('sb', '_secret_', 'Ab3_x9-Qr7');
    expect(scrubTokenShapes(`k=${sb};`)).toBe('k=[redacted];');
    const ht = j('harmony', '_', 'ab12'.repeat(16));
    expect(scrubTokenShapes(`t=${ht};`)).toBe('t=[redacted];');
    // a publishable key and a short harmony_ word are not credentials
    expect(containsTokenShape('the harmony_plugin package')).toBe(false);
    expect(containsTokenShape(j('sb', '_publishable_', 'abc'))).toBe(false);
  });

  it('scrubs the whole token, not just its prefix, and is idempotent', () => {
    const t = j('gh', 's_', 'Zz9'.repeat(12));
    expect(scrubTokenShapes(`x=${t};`)).toBe('x=[redacted];');
    expect(scrubTokenShapes(scrubTokenShapes(`x=${t};`))).toBe('x=[redacted];');
  });

  it('redacts every Figma token prefix whole, body with _ and - included (B-1452: the leak was figu_)', () => {
    for (const prefix of ['gu_', 'gd_']) {
      // Short runs separated by _ and - so the long-base64-run fallback cannot be what catches it.
      const t = j('fi', prefix, 'Ab3_x9-Qr7_kL2-mN8_pZ4-tV6');
      expect(containsTokenShape(t)).toBe(true);
      expect(containsTokenShape(`token ${t} leaked`)).toBe(true);
      const out = scrubTokenShapes(`token ${t} leaked`);
      expect(out).toBe('token [redacted] leaked');
      expect(out).not.toContain(j('fi', prefix));
    }
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
