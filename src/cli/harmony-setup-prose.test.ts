// B-1501 fix 2: /harmony-setup's commands are run by the agent's shell tool, so their arguments are in
// the session transcript. The prose must never put a token in a command line, a here-string or a read
// of settings.local.json the agent sees.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

// B-1501 second fix pass, item D: run the prose's own `node -e` commands in a throwaway directory.

/** Every `node -e '<code>'` script in the prose, in order. */
const scripts = [...prose.matchAll(/node -e '([^']+)'/g)].map((m) => m[1]);
const inspect = scripts.find((s) => s.includes('value not shown'))!;
const setCmd = scripts.find((s) => s.includes('HARMONY_PROJECT:p'))!;
const removeCmd = scripts.find((s) => s.includes('delete s.env.HARMONY_API_TOKEN'))!;

function withSettings(env: Record<string, string>, mode: number, fn: (dir: string, file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1501-setup-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    const file = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(file, JSON.stringify({ env, other: { keep: true } }), { mode });
    fs.chmodSync(file, mode);
    fn(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir: string, code: string, args: string[] = []) => execFileSync(process.execPath, ['-e', code, ...args], { cwd: dir, encoding: 'utf8' });

describe('commands/harmony-setup.md settings commands (B-1501 D)', () => {
  it('inspect prints names for everything, values only for HARMONY_SUPABASE_URL and HARMONY_PROJECT', () => {
    expect(inspect).toBeDefined();
    const env = {
      HARMONY_API_TOKEN: 'synthetic-token-value',
      HARMONY_PROJECT: 'invented',
      HARMONY_SUPABASE_URL: 'https://inv.example.supabase.co',
      HARMONY_SUPABASE_ANON_KEY: 'synthetic-anon-value',
      SOME_OTHER_SETTING: 'synthetic-other-value',
      DB_PASSWORD: 'synthetic-password-value',
    };
    withSettings(env, 0o600, (dir) => {
      const out = run(dir, inspect);
      expect(out).toContain('HARMONY_PROJECT=invented');
      expect(out).toContain('HARMONY_SUPABASE_URL=https://inv.example.supabase.co');
      for (const name of Object.keys(env)) expect(out).toContain(name);
      for (const value of ['synthetic-token-value', 'synthetic-anon-value', 'synthetic-other-value', 'synthetic-password-value']) {
        expect(out).not.toContain(value);
      }
    });
  });

  for (const [label, pick, args] of [
    ['set', () => setCmd, ['invented']],
    ['remove', () => removeCmd, []],
  ] as const) {
    it(`${label} writes atomically (temp + rename) and keeps the file's mode`, () => {
      const code = pick();
      expect(code).toBeDefined();
      expect(code).toContain('renameSync');
      withSettings({ HARMONY_API_TOKEN: 'synthetic-token-value' }, 0o640, (dir, file) => {
        const before = fs.statSync(file);
        run(dir, code, [...args]);
        const after = fs.statSync(file);
        expect(after.mode & 0o777).toBe(0o640);
        expect(after.ino).not.toBe(before.ino);
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(s.other).toEqual({ keep: true });
        if (label === 'set') expect(s.env.HARMONY_PROJECT).toBe('invented');
        else expect(s.env.HARMONY_API_TOKEN).toBeUndefined();
        expect(fs.readdirSync(path.join(dir, '.claude'))).toEqual(['settings.local.json']);
      });
    });
  }
});
