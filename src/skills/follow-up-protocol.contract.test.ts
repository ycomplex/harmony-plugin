import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUFFER = 'Follow-ups rollup v1 id=<key>';
const DRAIN = 'Follow-ups rollup drained v1 id=<key>';
function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

/** Check writer instructions locally: a footer cannot repair a contradictory instruction. */
function missingProtocol(text: string): string[] {
  return text.split(/\n\s*\n/).filter(paragraph => {
    const plain = paragraph.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
    const namesBuffer = /follow-ups rollup/i.test(plain);
    const instructsWriter = /\b(post|append|accumulate|buffering|draining|drain)\b/i.test(plain);
    // The shared protocol reference defines headers in separate fenced blocks; checked below.
    return namesBuffer && instructsWriter && (!paragraph.includes(BUFFER) || !paragraph.includes(DRAIN));
  });
}

describe('skills-wide follow-up writer protocol (B-1392)', () => {
  it('requires exact buffer and separate drain headers in every writer instruction', () => {
    const failures = markdownFiles(join(process.cwd(), 'skills'))
      .filter(path => !path.endsWith('/harmony-shared/disposition-discipline.md'))
      .flatMap(path => missingProtocol(readFileSync(path, 'utf8')).map(paragraph => `${path}: ${paragraph}`));
    expect(failures).toEqual([]);
  });

  it('rejects the old release/verify wording and new unversioned writer instructions', () => {
    for (const instruction of [
      'Post ONE consolidated **"Follow-ups rollup"** comment recording terminal resolution.',
      'Drain in ONE consolidated **"Follow-ups rollup"** comment, followed by triage-and-consolidate.',
      'Accumulate findings in the per-parent "Follow-ups rollup" buffer.',
    ]) {
      expect(missingProtocol(instruction)).toEqual([instruction]);
    }
    expect(missingProtocol(`Post buffer with first line ${BUFFER}; append a separate drain comment with first line ${DRAIN}.`)).toEqual([]);
  });

  it('pins the shared protocol source and the two finish-work drain sites', () => {
    const shared = readFileSync(join(process.cwd(), 'skills/harmony-shared/disposition-discipline.md'), 'utf8');
    expect(shared).toContain(`\n${BUFFER}\n`);
    expect(shared).toContain(`\n${DRAIN}\n`);
    const finish = readFileSync(join(process.cwd(), 'skills/finish-work/SKILL.md'), 'utf8');
    for (const heading of ['**DRAIN the "Follow-ups rollup" buffer', '**Drain any remaining rollup items']) {
      const paragraph = finish.slice(finish.indexOf(heading)).split(/\n\s*\n/)[0];
      expect(paragraph).toContain(BUFFER);
      expect(paragraph).toContain(DRAIN);
      expect(paragraph).toMatch(/separate drain comment/);
      expect(paragraph).toContain('triage-and-consolidate');
      for (const outcome of ['fix-inline', 'fold-into-existing', 'drop-with-reason', 'file-a-ticket']) expect(paragraph).toContain(outcome);
    }
  });
});
