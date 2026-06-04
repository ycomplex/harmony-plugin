import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTML = readFileSync(
  join(process.cwd(), 'skills', 'harmony-visual-handoff', 'templates', 'visual-surface.html'),
  'utf8',
);

describe('visual-surface.html template scaffold', () => {
  it('is a single self-contained file (no external runtime deps) + dark theme', () => {
    expect(HTML).toMatch(/<!DOCTYPE html>/i);
    expect(HTML).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//i); // nothing loaded off the network
    expect(HTML).toMatch(/:root\s*\{[^}]*--bg/);                     // dark-theme token block
  });
  it('carries the tier-1 guard-rail banner with #sketch + "g" toggle', () => {
    expect(HTML).toContain('id="banner"');
    expect(HTML).toMatch(/generated sketch/i);
    expect(HTML).toMatch(/location\.hash/);
    expect(HTML).toContain("'sketch'");
    expect(HTML).toMatch(/key\s*===?\s*'g'/i);
  });
  it('carries the tier-2 element-level provenance system', () => {
    expect(HTML).toContain('data-prov');
    expect(HTML).toMatch(/prov-legend/);
    for (const v of ['real', 'invented', 'illustrative']) {
      expect(HTML).toContain(v);
    }
  });
  it('supports parametric + a NAVIGABLE walk + storyboard previews with live update', () => {
    for (const mode of ['parametric', 'walk', 'storyboard']) {
      expect(HTML).toContain(mode);
    }
    expect(HTML).toMatch(/function updateAll/);
    // F4: the walk view must actually advance — Back/Next controls + a step increment + a nav handler,
    // not a static "Step 1" stub. (Copied from the B-328 onboarding playground's working bindNav pattern.)
    expect(HTML).toMatch(/data-act="next"/);
    expect(HTML).toMatch(/data-act="back"/);
    expect(HTML).toMatch(/state\.step\s*\+\s*1/);
    expect(HTML).toMatch(/function bindNav/);
  });
  it('has a decision-framed copy-out spec + a Recommended preset', () => {
    expect(HTML).toContain('id="spec"');
    expect(HTML).toContain('id="copyBtn"');
    expect(HTML).toMatch(/clipboard/);
    expect(HTML).toContain('Recommended');
  });
});
