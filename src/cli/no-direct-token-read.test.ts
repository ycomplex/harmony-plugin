// B-1501 fix 8: every CLI path picks its project and token through ONE resolver
// (src/config/project-resolution.ts: HARMONY_API_TOKEN, then HARMONY_PROJECT, then the active
// project). A file under src/cli that reads HARMONY_API_TOKEN itself bypasses HARMONY_PROJECT, so a
// session set up with HARMONY_PROJECT only would be told "HARMONY_API_TOKEN is not set". This test
// fails on any such read outside the allowlist below. Mentions in messages are fine; only reads count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Genuine exceptions, each with its reason. Paths are relative to src/cli. */
const ALLOWED: Record<string, string> = {
  'commands/conductor-preflight.ts':
    "checks the conductor HOST's daemon environment (conductor.env, the host file's secrets, the shell): the daemon itself requires HARMONY_API_TOKEN and stays environment-only",
  'commands/auth.ts':
    "adopt-settings-token reads env.HARMONY_API_TOKEN out of a .claude/settings.local.json FILE's JSON to move it into the store, not from this process's environment",
};

/** A read in code: `<x>.HARMONY_API_TOKEN` (outside a string), `<x>['HARMONY_API_TOKEN']`,
 *  `harmonyEnv('HARMONY_API_TOKEN')`, or `{ HARMONY_API_TOKEN } = <...>env`. */
const DOT = /\.HARMONY_API_TOKEN\b|\{[^}]*\bHARMONY_API_TOKEN\b[^}]*\}\s*=\s*[\w.]*env\b/;
const QUOTED = /\[\s*['"`]HARMONY_API_TOKEN['"`]\s*\]|harmonyEnv\(\s*['"`]HARMONY_API_TOKEN/;
const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const READ = { test: (line: string) => QUOTED.test(line) || DOT.test(line.replace(STRING, "''")) };

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.fixture\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('no CLI file reads HARMONY_API_TOKEN directly (B-1501 fix 8)', () => {
  it('every read goes through resolveProject, except the allowlisted ones', () => {
    const offenders: string[] = [];
    for (const file of walk(CLI_DIR)) {
      const rel = path.relative(CLI_DIR, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;
      stripComments(fs.readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (READ.test(line)) offenders.push(`src/cli/${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still exists and still needs its exception', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const src = stripComments(fs.readFileSync(path.join(CLI_DIR, rel), 'utf8'));
      expect(src.split('\n').some((l) => READ.test(l)), rel).toBe(true);
    }
  });

  it('the pattern catches a direct read (positive control)', () => {
    expect(READ.test('const t = process.env.HARMONY_API_TOKEN;')).toBe(true);
    expect(READ.test("const t = env['HARMONY_API_TOKEN'];")).toBe(true);
    expect(READ.test("harmonyEnv('HARMONY_API_TOKEN', env)")).toBe(true);
    expect(READ.test("throw new Error('HARMONY_API_TOKEN is not set')")).toBe(false);
  });
});
