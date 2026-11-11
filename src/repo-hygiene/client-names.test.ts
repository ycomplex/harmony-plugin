import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LISTED_HASHES, findListedNames, hashName, scanRepository } from './client-names.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('no listed client name in the repository (B-1459)', () => {
  it('the tracked files carry none of the listed names', () => {
    const hits = scanRepository(ROOT);
    const where = hits.map(h => `${h.file}:${h.line}`).join('\n');
    expect(hits, `a listed client name reappeared — reword it to a neutral description (see CLAUDE.md):\n${where}`)
      .toEqual([]);
  }, 60000);

  it('every listed hash is a 64-character lowercase hex SHA-256', () => {
    expect(LISTED_HASHES.length).toBeGreaterThan(0);
    for (const h of LISTED_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('findListedNames — positive control with an invented name', () => {
  const hashes = [hashName('Zorblax')];
  it.each(['In the Zorblax walk', 'Zorb Lax portal', 'zorblax-customer-portal'])('flags %j', text => {
    expect(findListedNames(`first line\n${text}\nlast line`, hashes)).toEqual([{ line: 2 }]);
  });
  it.each(['zorblaxian', 'Zorb walk'])('does not flag %j', text => {
    expect(findListedNames(text, hashes)).toEqual([]);
  });
});

describe('scripts/hash-client-name.mjs', () => {
  it('prints the same salted hash as hashName', () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/hash-client-name.mjs', import.meta.url)), 'Zorblax'],
      { encoding: 'utf8' });
    expect(out.trim()).toBe(hashName('Zorblax'));
  });
});
