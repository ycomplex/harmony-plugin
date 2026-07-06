import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSharedDoc } from './skill-contract.js';

const SKILLS_ROOT = join(process.cwd(), 'skills');

// B-660: every skill that AUTHORS a brief must point at the shared brief-authoring contract
// (skills/harmony-shared/brief-authoring.md) at its compose step — pointers only, never a
// restated copy. Authoring is detected STRUCTURALLY: an actual compose_brief invocation
// template (`mcp__harmony__compose_brief({`), which only authoring skills carry. Skills that
// merely CONSUME/surface briefs (harmony-conduct, harmony-next, harmony-queue) mention the
// tool in prose but never as a call site, so no exemption list is needed — and a ninth
// authoring skill added later inherits the pointer requirement automatically.
const AUTHORING_CALL_SITE = /mcp__harmony__compose_brief\s*\(\s*\{/;

const skillDirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS_ROOT, d.name, 'SKILL.md')))
  .map((d) => d.name);

const skillText = (name: string): string =>
  readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');

const authoringSkills = skillDirs.filter((name) => AUTHORING_CALL_SITE.test(skillText(name)));

describe('brief-authoring pointer wiring (B-660)', () => {
  it('detects the eight known authoring skills (regex sanity — a rewrite must not silently exempt everyone)', () => {
    for (const known of [
      'finish-work', 'harmony-clarify', 'harmony-decompose', 'harmony-design-decide',
      'harmony-revise-scope', 'harmony-stale-patch', 'harmony-visual-handoff', 'start-work',
    ]) {
      expect(authoringSkills, `expected ${known} to be detected as an authoring skill`).toContain(known);
    }
  });

  it('classifies the brief consumers as non-authoring (they surface briefs, never compose them)', () => {
    for (const consumer of ['harmony-conduct', 'harmony-next', 'harmony-queue']) {
      expect(authoringSkills, `${consumer} must not carry a compose_brief call site`).not.toContain(consumer);
    }
  });

  it('every authoring skill points at brief-authoring.md (a ninth authoring skill must add the pointer)', () => {
    for (const name of authoringSkills) {
      expect(
        skillText(name),
        `${name}/SKILL.md authors a brief (compose_brief call site) but never references brief-authoring.md`,
      ).toContain('brief-authoring.md');
    }
  });

  it('each known authoring skill points at its own gate section', () => {
    const sections: Record<string, string[]> = {
      'harmony-clarify': ['§Clarify'],
      'harmony-decompose': ['§Decompose'],
      'harmony-design-decide': ['§Design'],
      'harmony-visual-handoff': ['§Design'],
      'start-work': ['§Plan', '§Release'],
      'finish-work': ['§Verify'],
      'harmony-revise-scope': ['§Auxiliary briefs'],
      'harmony-stale-patch': ['§Auxiliary briefs'],
    };
    for (const [name, tags] of Object.entries(sections)) {
      const text = skillText(name);
      for (const tag of tags) {
        expect(text, `${name}/SKILL.md missing the ${tag} pointer`).toContain(`brief-authoring.md\` ${tag}`);
      }
    }
  });
});

describe('brief-authoring.md structure (B-660)', () => {
  const doc = readSharedDoc('brief-authoring');

  it('carries the shared core, legibility contract, engagement model, per-gate contracts, and auxiliary briefs', () => {
    for (const section of [
      '## Shared core', '## Legibility contract', '## Engagement model',
      '## Per-gate contracts', '## Auxiliary briefs',
    ]) {
      expect(doc, `brief-authoring.md missing section ${section}`).toContain(section);
    }
  });

  it('carries all six per-gate sections', () => {
    for (const gate of ['Clarify', 'Decompose', 'Design', 'Plan', 'Release', 'Verify']) {
      expect(doc, `brief-authoring.md missing the ${gate} gate section`).toMatch(
        new RegExp(`^### ${gate} \\(`, 'm'),
      );
    }
  });

  it('marks release + verify as the hard floor and plan as the only lead-by-system gate', () => {
    expect(doc).toMatch(/### Release .*HARD FLOOR/);
    expect(doc).toMatch(/### Verify .*HARD FLOOR/);
    expect(doc).toMatch(/\*\*Plan\*\* — the\s+only one/);
  });

  it('states the brief-is-the-summary rule (depth lives in the linked decision entry)', () => {
    expect(doc).toContain('depth lives in the linked decision entry');
    expect(doc).toContain('B-669'); // navigation deferred, but the brief still states the rule
  });

  it('encodes the verify runbook and the umbrella integration-check stance', () => {
    expect(doc.toLowerCase()).toContain('runbook');
    expect(doc).toContain('do-X → expect-Y');
    expect(doc).toContain('not a different mode');
  });

  it('speaks the post-B-637 vocabulary (states + gate names)', () => {
    expect(doc).toContain('Proposed → Clarified');
    expect(doc).toContain('Built → Deployed');
    expect(doc).not.toMatch(/\bReleased\b/); // the pre-rename state name must not reappear
  });
});
