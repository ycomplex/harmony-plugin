// B-1423: `hooks/seat-session-start.sh` and `hooks/seat-stop-guard.sh`, executed FOR REAL against a temp
// HARMONY_HOME (never the real ~/.harmony). The no-op path is the cloud-leg proof: a session no seat
// profile names exits 0 WITHOUT starting node, shown with a sentinel `node` shim first on PATH that
// leaves a marker file if it ever runs.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const START = join(ROOT, 'hooks', 'seat-session-start.sh');
const STOP = join(ROOT, 'hooks', 'seat-stop-guard.sh');
const REAL_DIST_HOOK = join(ROOT, 'dist', 'bin', 'seat-hook.js');
const SID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';

interface Sandbox {
  home: string;
  seats: string;
  pluginRoot: string;
  stubDir: string;
  marker: string;
}

/** A temp HARMONY_HOME, a plugin root with a (stub) dist/bin/seat-hook.js, and a sentinel node shim. */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'b1423-sh-'));
  const home = join(root, 'harmony');
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(pluginRoot, 'dist', 'bin', 'seat-hook.js'), '// stub\n');
  const stubDir = join(root, 'stub');
  mkdirSync(stubDir);
  const marker = join(root, 'node-invoked.marker');
  writeFileSync(
    join(stubDir, 'node'),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> "${marker}"`, 'cat >/dev/null', `printf '{"stub":true}\\n'`, 'exit 0', ''].join('\n'),
    { mode: 0o755 },
  );
  return { home, seats: join(home, 'seats'), pluginRoot, stubDir, marker };
}

function run(script: string, sb: Sandbox, input: unknown, over: Record<string, string | undefined> = {}) {
  const r = spawnSync('sh', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HARMONY_HOME: sb.home,
      CLAUDE_PLUGIN_ROOT: sb.pluginRoot,
      PATH: `${sb.stubDir}:${process.env.PATH}`,
      ...over,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeProfile(sb: Sandbox, name: string, sessionId: string): string {
  mkdirSync(sb.seats, { recursive: true });
  const p = join(sb.seats, `${name}.yml`);
  writeFileSync(p, `session_id: ${sessionId}\nproject: B\nmilestone: v1.13\n`);
  return p;
}

const startInput = (id = SID) => ({ session_id: id, hook_event_name: 'SessionStart', source: 'startup' });
const stopInput = (id = SID) => ({ session_id: id, hook_event_name: 'Stop', stop_hook_active: false });

describe('seat hooks: the no-op fast path never starts node (cloud-leg proof)', () => {
  const cases: Array<[string, (sb: Sandbox) => void, string?]> = [
    ['no seats directory at all', () => {}],
    ['a seats directory whose profiles name OTHER session ids', (sb) => {
      writeProfile(sb, 'orch', 'some-other-session');
      writeProfile(sb, 'other', `${SID}-suffix`);
    }],
    ['an empty seats directory', (sb) => mkdirSync(sb.seats, { recursive: true })],
    ['a malicious session id containing *', (sb) => writeProfile(sb, 'orch', SID), '*'],
    ['a malicious session id containing /', (sb) => writeProfile(sb, 'orch', SID), '../seats/orch'],
    ['an empty session id', (sb) => writeProfile(sb, 'orch', SID), ''],
  ];

  for (const [name, setup, id] of cases) {
    it(`${name}: both wrappers exit 0, SessionStart prints {}, no node`, () => {
      const sb = sandbox();
      setup(sb);
      const sid = id ?? SID;
      const s = run(START, sb, startInput(sid));
      expect(s.status).toBe(0);
      expect(s.stdout.trim()).toBe('{}');
      const t = run(STOP, sb, stopInput(sid));
      expect(t.status).toBe(0);
      expect(t.stdout).toBe('');
      expect(existsSync(sb.marker)).toBe(false);
    });
  }

  it('the profile deleted after previously matching: back on the no-op path', () => {
    const sb = sandbox();
    const p = writeProfile(sb, 'orch', SID);
    expect(run(STOP, sb, stopInput()).status).toBe(0);
    expect(existsSync(sb.marker)).toBe(true); // control: it matched while the profile existed
    rmSync(sb.marker);
    rmSync(p);
    expect(run(START, sb, startInput()).stdout.trim()).toBe('{}');
    expect(run(STOP, sb, stopInput()).status).toBe(0);
    expect(existsSync(sb.marker)).toBe(false);
  });

  it('a session id that only appears inside a longer profile line does not match (whole line, fixed string)', () => {
    const sb = sandbox();
    mkdirSync(sb.seats, { recursive: true });
    writeFileSync(join(sb.seats, 'orch.yml'), `# session_id: ${SID}\nnote: session_id: ${SID}\n`);
    expect(run(STOP, sb, stopInput()).status).toBe(0);
    expect(existsSync(sb.marker)).toBe(false);
  });

  it('an unparseable payload -> exit 0, no node', () => {
    const sb = sandbox();
    writeProfile(sb, 'orch', SID);
    expect(run(START, sb, 'not json').stdout.trim()).toBe('{}');
    expect(run(STOP, sb, 'not json').status).toBe(0);
    expect(existsSync(sb.marker)).toBe(false);
  });

  it('a matching profile but no built dist/bin/seat-hook.js -> exit 0, no node', () => {
    const sb = sandbox();
    writeProfile(sb, 'orch', SID);
    rmSync(join(sb.pluginRoot, 'dist'), { recursive: true });
    expect(run(START, sb, startInput()).stdout.trim()).toBe('{}');
    expect(run(STOP, sb, stopInput()).status).toBe(0);
    expect(existsSync(sb.marker)).toBe(false);
  });
});

describe('seat hooks: a matching profile reaches node', () => {
  it('SessionStart pipes to `seat-hook.js start <profile>` and prints its output', () => {
    const sb = sandbox();
    const p = writeProfile(sb, 'orch', SID);
    const s = run(START, sb, startInput());
    expect(s.status).toBe(0);
    expect(s.stdout.trim()).toBe('{"stub":true}');
    expect(readFileSync(sb.marker, 'utf8')).toContain(`seat-hook.js start ${p}`);
  });

  it('Stop pipes to `seat-hook.js stop <profile>`', () => {
    const sb = sandbox();
    const p = writeProfile(sb, 'orch', SID);
    expect(run(STOP, sb, stopInput()).status).toBe(0);
    expect(readFileSync(sb.marker, 'utf8')).toContain(`seat-hook.js stop ${p}`);
  });

  for (const [form, line] of [
    ['double-quoted', `session_id: "${SID}"`],
    ['single-quoted', `session_id: '${SID}'`],
  ] as const) {
    it(`a ${form} session_id turns both hooks on (B-1429)`, () => {
      const sb = sandbox();
      mkdirSync(sb.seats, { recursive: true });
      const p = join(sb.seats, 'orch.yml');
      writeFileSync(p, `${line}\nproject: B\nmilestone: v1.13\n`);
      const s = run(START, sb, startInput());
      expect(s.status).toBe(0);
      expect(s.stdout.trim()).toBe('{"stub":true}');
      expect(run(STOP, sb, stopInput()).status).toBe(0);
      const calls = readFileSync(sb.marker, 'utf8');
      expect(calls).toContain(`seat-hook.js start ${p}`);
      expect(calls).toContain(`seat-hook.js stop ${p}`);
    });

    it(`a ${form} session_id naming ANOTHER session stays on the no-node path`, () => {
      const sb = sandbox();
      mkdirSync(sb.seats, { recursive: true });
      writeFileSync(join(sb.seats, 'orch.yml'), `${line.replace(SID, 'some-other-session')}\n`);
      expect(run(START, sb, startInput()).stdout.trim()).toBe('{}');
      expect(run(STOP, sb, stopInput()).status).toBe(0);
      expect(existsSync(sb.marker)).toBe(false);
    });
  }

  it('an empty HARMONY_HOME counts as unset ($HOME/.harmony)', () => {
    const sb = sandbox();
    const fakeHome = join(sb.home, 'userhome');
    mkdirSync(join(fakeHome, '.harmony', 'seats'), { recursive: true });
    writeFileSync(join(fakeHome, '.harmony', 'seats', 'orch.yml'), `session_id: ${SID}\n`);
    expect(run(STOP, sb, stopInput(), { HARMONY_HOME: '', HOME: fakeHome }).status).toBe(0);
    expect(existsSync(sb.marker)).toBe(true);
  });

  it.skipIf(!existsSync(REAL_DIST_HOOK))('with the real built seat-hook.js: no heartbeat blocks the stop (exit 2) with the re-arm command', () => {
    const sb = sandbox();
    writeProfile(sb, 'orch', SID);
    const r = run(STOP, sb, stopInput(), { CLAUDE_PLUGIN_ROOT: ROOT, PATH: process.env.PATH });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no heartbeat');
    expect(r.stderr).toContain('harmony watch --seat orch --milestone v1.13 --until-event');
    expect(r.stderr).toContain('your last line must say this seat is unwatched');
    // stop_hook_active: the second stop is let through.
    const again = run(STOP, sb, { ...stopInput(), stop_hook_active: true }, { CLAUDE_PLUGIN_ROOT: ROOT, PATH: process.env.PATH });
    expect(again.status).toBe(0);
  });

  it.skipIf(!existsSync(REAL_DIST_HOOK))('with the real built seat-hook.js: SessionStart emits SessionStart context and never fails', () => {
    const sb = sandbox();
    writeProfile(sb, 'orch', SID);
    const r = run(START, sb, { ...startInput(), source: 'resume' }, { CLAUDE_PLUGIN_ROOT: ROOT, PATH: process.env.PATH });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Harmony seat orch (milestone v1.13): board check at session start');
    expect(out.hookSpecificOutput.additionalContext).toContain('re-arm with: harmony watch --seat orch --milestone v1.13 --until-event');
  }, 40_000);
});

describe('hooks.json registers the seat hooks beside the existing ones', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
  };

  it('a new SessionStart entry runs seat-session-start.sh with a bounded timeout', () => {
    const entry = hooks.hooks.SessionStart.find((g) => g.hooks.some((h) => h.command.includes('hooks/seat-session-start.sh')));
    expect(entry).toBeDefined();
    expect(entry!.hooks[0]).toEqual({ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/seat-session-start.sh"', timeout: 30 });
  });

  it("a SECOND Stop entry runs seat-stop-guard.sh; stop-gate.sh's entry is unchanged and first", () => {
    const stop = hooks.hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual({ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stop-gate.sh"', timeout: 30 }] });
    expect(stop[1]).toEqual({ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/seat-stop-guard.sh"', timeout: 10 }] });
  });

  it('both wrappers do the directory test and grep before they ever mention node', () => {
    for (const script of [START, STOP]) {
      const body = readFileSync(script, 'utf8');
      const dirTest = body.indexOf('[ -d "$D" ]');
      const grep = body.indexOf(`grep -l -x -F -e "session_id: $ID" -e "session_id: \\"$ID\\"" -e "session_id: '$ID'"`);
      const node = body.indexOf('node "$HOOK"');
      expect(dirTest).toBeGreaterThan(-1);
      expect(grep).toBeGreaterThan(dirTest);
      expect(node).toBeGreaterThan(grep);
    }
  });
});
