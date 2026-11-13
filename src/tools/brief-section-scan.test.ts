// B-1305: the brief-section credential scan.
import { describe, expect, it } from 'vitest';
import { describeScanFinding, scanSectionText } from './brief-section-scan.js';

// Built at runtime so this source file carries no literal token shape.
const j = (...p: string[]) => p.join('');

describe('scanSectionText', () => {
  const cases: Array<[string, string]> = [
    ['figma', j('fi', 'gd_', 'abc-DEF_123')],
    ['github', j('gh', 'p_', 'x'.repeat(36))],
    ['sk-key', j('s', 'k-', 'proj-abc123')],
    ['jwt', j('ey', 'Jhb', 'GciOi.eyJzdWIi.sig')],
    ['supabase-secret-key', j('sb', '_secret_', 'Ab3_x9-Qr7')],
    ['harmony-api-token', j('harmony', '_', 'cd34'.repeat(16))],
    ['private-key-block', j('-----BEGIN ', 'PRIVATE', ' KEY-----')],
  ];
  it.each(cases)('flags a %s shape by name only', (shape, sample) => {
    const f = scanSectionText(`The step used ${sample} here.`, {});
    expect(f).toEqual({ kind: 'shape', shape });
    expect(JSON.stringify(f)).not.toContain(sample);
  });

  it('flags the exact value of a credential-named variable, naming only the variable', () => {
    const value = j('plain', '-value-', 'with-no-shape-at-all');
    const f = scanSectionText(`config was ${value}.`, { DEPLOY_PASSWORD: value, HOME: '/home/someone/long/enough' });
    expect(f).toEqual({ kind: 'env', variable: 'DEPLOY_PASSWORD' });
    expect(describeScanFinding(f!)).toContain('DEPLOY_PASSWORD');
    expect(describeScanFinding(f!)).not.toContain(value);
  });

  it('ignores short values and variables whose name does not look like a credential', () => {
    expect(scanSectionText('the value short-tok appears', { MY_TOKEN: 'short-tok' })).toBeNull();
    const path = '/workspace/project/src/components/long/path/name';
    expect(scanSectionText(`see ${path}`, { PWD: path })).toBeNull();
    expect(scanSectionText(`see ${path}`, { api_key: path })).toEqual({ kind: 'env', variable: 'api_key' });
  });

  it('does not flag a 40-character git SHA or a long path (no catch-all)', () => {
    expect(scanSectionText('Merged at 3f2a9c1e5b7d4a6f8e0c2b4d6a8f0e1c3b5d7a9f.', {})).toBeNull();
    expect(scanSectionText('Edited src/components/ProjectSettingsBriefSectionsPanelHeaderTitle/index.tsx', {})).toBeNull();
  });

  it('returns null for empty and non-string input', () => {
    expect(scanSectionText('', {})).toBeNull();
    expect(scanSectionText(undefined as unknown as string, {})).toBeNull();
  });
});
