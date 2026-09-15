import { describe, it, expect } from 'vitest';
import { readSkill, readSharedDoc } from './skill-contract.js';
import { REVISION_CAUSE_SOURCES } from '../tools/revision-cause.js';

// B-1017 — one shared section states how a redraft names its cause; every skill that recomposes a brief
// points at it rather than restating it. Prose contract, same read-the-file idiom as the sibling
// *.contract.test.ts files here: the section's heading is the pointer text, so a rename breaks every
// pointer at once and this test says so.
const POINTER = 'Stating the cause of a redraft';
const GATE_SKILLS = [
  'harmony-clarify', 'harmony-decompose', 'harmony-design-decide', 'start-work', 'finish-work',
  'harmony-stale-patch', 'harmony-revise-scope', 'harmony-conduct',
];

describe('B-1017 — every recomposing skill points at the shared revision-cause section', () => {
  const doc = readSharedDoc('brief-authoring');

  it('brief-authoring.md carries the section and names all seven sources', () => {
    expect(doc).toContain(`## ${POINTER}`);
    for (const s of REVISION_CAUSE_SOURCES) {
      expect(doc, `source ${s} missing from the section`).toContain(`\`${s}\``);
    }
  });

  it('the section binds each source to what the caller passes — and forbids passing a send-back source', () => {
    const section = doc.slice(doc.indexOf(`## ${POINTER}`));
    const body = section.slice(0, section.indexOf('\n## ', 1) > 0 ? section.indexOf('\n## ', 1) : undefined);
    expect(body).toContain('`revision_cause`');
    expect(body).toContain('`iterate_feedback`');
    expect(body).toMatch(/lint\.warnings/);
    expect(body).toMatch(/never pass a send-back `source`/i);
    expect(body).toMatch(/No cause recorded/);
  });

  for (const skill of GATE_SKILLS) {
    it(`${skill}/SKILL.md points at the section`, () => {
      const { body } = readSkill(skill);
      expect(body).toContain(POINTER);
    });
  }

  it('harmony-conduct names the three cause sources its own recompose sites own', () => {
    const { body } = readSkill('harmony-conduct');
    expect(body).toContain("source: 'after-discussion'");
    expect(body).toContain("source: 'accept-remark'");
    // §4d: the browser reshape passes iterate_feedback only; the sender is DERIVED, never named.
    expect(body).toMatch(/sender is derived/i);
  });

  it('finish-work names refreshed-inputs on the O3 re-entry recompose', () => {
    const { body } = readSkill('finish-work');
    expect(body).toContain("source: 'refreshed-inputs'");
  });
});
