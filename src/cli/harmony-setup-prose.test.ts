// B-1501 fix 2: /harmony-setup's commands are run by the agent's shell tool, so their arguments are in
// the session transcript. The prose must never put a token in a command line, a here-string or a read
// of settings.local.json the agent sees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../commands/harmony-setup.md');
const prose = fs.readFileSync(FILE, 'utf8');
/** The prose with markdown bold markers removed and whitespace collapsed, for phrase checks. */
const flat = prose.replace(/\*\*/g, '').replace(/\s+/g, ' ');

describe('commands/harmony-setup.md never routes a token through the agent (B-1501)', () => {
  it('has no here-string, no --token <value> and no token placeholder in a command', () => {
    expect(prose).not.toContain('<<<');
    expect(prose).not.toMatch(/--token\s+<|--token\s+'/);
    expect(prose).not.toMatch(/'<token>'/);
  });

  it('moves an existing copy with adopt-settings-token, and proves the stored copy before removing the file copy', () => {
    const adopt = prose.indexOf('harmony project adopt-settings-token --file .claude/settings.local.json');
    const proof = prose.indexOf('env -u HARMONY_API_TOKEN HARMONY_PROJECT=<key> harmony project info');
    const removal = prose.indexOf('delete s.env.HARMONY_API_TOKEN');
    expect(adopt).toBeGreaterThan(0);
    expect(proof).toBeGreaterThan(adopt);
    expect(removal).toBeGreaterThan(proof);
  });

  it('hands a new token to the person\'s own terminal, and never opens settings.local.json with the Read tool', () => {
    expect(flat).toContain('in a terminal of their own');
    expect(prose).toContain('harmony login --no-activate --token-stdin');
    expect(flat).toContain('never open it with the Read tool');
    expect(prose).not.toMatch(/^Read `\.claude\/settings\.local\.json`/m);
  });
});
