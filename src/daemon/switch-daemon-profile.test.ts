// B-1164: container/gke/switch-daemon-profile.sh, EXECUTED for real from disk with stub executables first
// on PATH (same discipline as gke-cluster-scripts.test.ts): pgrep, kill, nohup, hostname, kubectl, gcloud
// and the board query are stubs; the script's own bash and node JSON handling is the real thing.
//
// The adoption check is deliberately board-based: the stub board flips the held conductions to the NEW
// daemon's lease holder, while the daemon log stays unrelated text — success must not depend on any log
// wording (B-1166 is changing the takeover log lines).
//
// What this does NOT prove: a real daemon, a real SIGTERM release, real kubectl / gcloud output shapes.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoPath = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const switchPath = repoPath('container/gke/switch-daemon-profile.sh');
const exampleProfile = JSON.parse(readFileSync(repoPath('container/gke/daemon-profile.gke.example.json'), 'utf8'));

const bashPath = (() => {
  try {
    return execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();
const CAPABLE = !!bashPath;

const OLD_PID = '4242';
const HOST = 'testhost';

interface World { dir: string; bin: string; state: string; logs: string; config: string; daemonLog: string }

function makeWorld(profiles: Record<string, unknown> = { gke: exampleProfile, cloud: { launch: 'bash cloud-launch.sh', reap: 'bash cloud-reap.sh' } }): World {
  const dir = mkdtempSync(join(tmpdir(), 'b1164-switch-'));
  const w: World = {
    dir, bin: join(dir, 'bin'), state: join(dir, 'state'), logs: join(dir, 'logs'),
    config: join(dir, 'deployment.json'), daemonLog: join(dir, 'daemon.log'),
  };
  for (const d of [w.bin, w.state, w.logs, join(dir, 'home')]) mkdirSync(d, { recursive: true });
  writeFileSync(w.config, JSON.stringify({ profiles }));
  writeFileSync(w.daemonLog, 'unrelated startup text, no takeover wording at all\n');
  const stub = (name: string, lines: string[]) =>
    writeFileSync(join(w.bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  const record = (name: string) => `printf '%s\\n' "$@" '--END--' >> "$STUB_LOGS/${name}.log"`;

  stub('hostname', [`echo ${HOST}`]);
  stub('pgrep', [record('pgrep'), `[ -n "\${STUB_NO_DAEMON:-}" ] && exit 1`, `echo ${OLD_PID}`]);
  stub('kill', [
    record('kill'),
    'if [ "$1" = "-TERM" ]; then [ -n "${STUB_IGNORE_TERM:-}" ] || touch "$STUB_STATE/dead-$2"; exit 0; fi',
    'if [ "$1" = "-0" ]; then [ -f "$STUB_STATE/dead-$2" ] && exit 1; exit 0; fi',
    'exit 0',
  ]);
  // The "daemon": records its argv, publishes its pid, then just stays alive briefly.
  stub('nohup', [record('nohup'), 'echo $$ > "$STUB_STATE/newpid"', 'exec sleep 20']);
  stub('kubectl', [
    record('kubectl'),
    'case " $* " in',
    '  *" get namespace "*) [ -n "${STUB_KUBE_DOWN:-}" ] && { echo "Unable to connect" >&2; exit 1; }; exit 0 ;;',
    '  *" get secret "*) [ -n "${STUB_NO_SECRET:-}" ] && exit 1; exit 0 ;;',
    '  *" get jobs "*) printf \'%s\' "${STUB_JOBS_JSON:-{\\"items\\":[]\\}}"; exit 0 ;;',
    'esac',
    'exit 0',
  ]);
  stub('gcloud', [
    record('gcloud'),
    'case " $* " in',
    '  *" run jobs describe "*) [ -n "${STUB_NO_CRJOB:-}" ] && exit 1; echo harmony-build-worker; exit 0 ;;',
    '  *" run jobs executions list "*) printf \'%s\' "${STUB_EXECS_JSON:-[]}"; exit 0 ;;',
    'esac',
    'exit 0',
  ]);
  // The replaceable board query. Two active conductions, held by the old daemon until the new one "adopts".
  stub('board-stub', [
    'now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    'old="2020-01-01T00:00:00Z"',
    'holder="$(hostname):' + OLD_PID + ':aaaa"; hb="$now"',
    'if [ -f "$STUB_STATE/newpid" ] && [ -z "${STUB_NO_ADOPT:-}" ]; then holder="$(hostname):$(cat "$STUB_STATE/newpid"):bbbb"; fi',
    '[ -n "${STUB_STALE_HB:-}" ] && [ -f "$STUB_STATE/newpid" ] && hb="$old"',
    'printf \'[{"id":"c-111","ticket":"B-1001","status":"active","lease_holder":"%s","last_heartbeat_at":"%s"},\' "$holder" "$hb"',
    'printf \'{"id":"c-222","ticket":"B-1002","status":"active","lease_holder":"%s","last_heartbeat_at":"%s"},\' "$holder" "$hb"',
    'printf \'{"id":"c-333","ticket":"B-1003","status":"active","lease_holder":"other:1:zzzz","last_heartbeat_at":"%s"}]\' "$now"',
  ]);
  return w;
}

function run(w: World, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(bashPath!, [switchPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${w.bin}:${process.env.PATH}`,
      HOME: join(w.dir, 'home'),
      STUB_LOGS: w.logs,
      STUB_STATE: w.state,
      HARMONY_API_TOKEN: 'tok',
      HARMONY_PLUGIN_DIR: '/plugin',
      HARMONY_SWITCH_BOARD_CMD: join(w.bin, 'board-stub'),
      HARMONY_SWITCH_TIMEOUT_S: '3',
      HARMONY_SWITCH_POLL_S: '0.2',
      HARMONY_SWITCH_STOP_TIMEOUT_S: '2',
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const go = (w: World, to: 'gke' | 'cloud', extra: string[] = [], env: Record<string, string> = {}) =>
  run(w, ['--to', to, '--config', w.config, '--log', w.daemonLog, ...extra], env);

function calls(w: World, name: string): string[][] {
  const p = join(w.logs, `${name}.log`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('--END--\n').filter((c) => c.length > 0).map((c) => c.replace(/\n$/, '').split('\n'));
}
const signalled = (w: World) => calls(w, 'kill').some((c) => c[0] === '-TERM');
const started = (w: World) => calls(w, 'nohup').length > 0;
const untouched = (w: World) => { expect(signalled(w)).toBe(false); expect(started(w)).toBe(false); };

const GKE_JOBS = JSON.stringify({
  items: [
    { metadata: { name: 'leg-a', labels: { 'harmony-ticket': 'B-1001', 'conduction-id': 'c-111' } }, status: {} },
    { metadata: { name: 'leg-done', labels: { 'harmony-ticket': 'B-9', 'conduction-id': 'c-9' } }, status: { conditions: [{ type: 'Complete', status: 'True' }] } },
    { metadata: { name: 'leg-failed', labels: { 'harmony-ticket': 'B-8', 'conduction-id': 'c-8' } }, status: { conditions: [{ type: 'Failed', status: 'True' }] } },
  ],
});
const CLOUD_EXECS = JSON.stringify([
  { metadata: { name: 'exec-1', labels: { 'conduction-id': 'c-222' } }, status: {} },
  { metadata: { name: 'exec-old', labels: { 'conduction-id': 'c-7' } }, status: { completionTime: '2026-10-19T00:00:00Z' } },
]);

describe.skipIf(!CAPABLE)('container/gke/switch-daemon-profile.sh (EXECUTED against stubs)', () => {
  it('passes bash -n, is executable, and rejects bad usage with exit 2', () => {
    expect(spawnSync(bashPath!, ['-n', switchPath]).status).toBe(0);
    expect(statSync(switchPath).mode & 0o111).not.toBe(0);
    expect(run(makeWorld(), []).status).toBe(2);
    expect(run(makeWorld(), ['--to', 'mars']).status).toBe(2);
    const help = run(makeWorld(), ['-h']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--force');
    expect(help.stdout).toContain('LAST RESORT');
  });

  describe('in-flight guard', () => {
    it('leaving gke: refuses, naming each running Job by ticket and conduction id; signals nothing', () => {
      const w = makeWorld();
      const r = go(w, 'cloud', [], { STUB_JOBS_JSON: GKE_JOBS });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('REFUSING');
      expect(r.stderr).toContain('B-1001  conduction c-111');
      expect(r.stderr).not.toContain('c-9'); // Complete / Failed Jobs are not in flight
      expect(r.stderr).not.toContain('c-8');
      untouched(w);
    });

    it('leaving cloud: refuses on a running execution, resolving its ticket from the board', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_EXECS_JSON: CLOUD_EXECS });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('B-1002  conduction c-222');
      expect(r.stderr).not.toContain('c-7');
      untouched(w);
    });

    it('--force proceeds past the guard, warns, and still confirms adoption', () => {
      const w = makeWorld();
      const r = go(w, 'gke', ['--force'], { STUB_EXECS_JSON: CLOUD_EXECS });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('--force');
      expect(r.stdout).toContain('B-1002  conduction c-222');
      expect(signalled(w)).toBe(true);
      expect(started(w)).toBe(true);
    });

    it('cannot tell (kubectl get jobs fails when leaving gke): does not proceed', () => {
      const w = makeWorld();
      // an unreadable Jobs listing (not JSON) must fail closed, not read as "nothing in flight"
      const r = go(w, 'cloud', [], { STUB_JOBS_JSON: 'not json' });
      expect(r.status).not.toBe(0);
      untouched(w);
    });
  });

  describe('--dry-run', () => {
    it('lists the held conductions and the plan, and changes nothing', () => {
      const w = makeWorld();
      const r = go(w, 'gke', ['--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('B-1001  conduction c-111');
      expect(r.stdout).toContain('B-1002  conduction c-222');
      expect(r.stdout).not.toContain('c-333'); // held by another holder
      expect(r.stdout).toContain('dry run: nothing changed');
      expect(r.stdout).toContain('--to cloud');
      untouched(w);
    });

    it('lists every in-flight leg by ticket and conduction id and says it would refuse (exit 3)', () => {
      const w = makeWorld();
      const r = go(w, 'cloud', ['--dry-run'], { STUB_JOBS_JSON: GKE_JOBS });
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('B-1001  conduction c-111');
      expect(r.stderr).toContain('B-1001  conduction c-111');
      expect(r.stdout).toContain('would refuse');
      untouched(w);
    });
  });

  describe('preflight', () => {
    const fails = (r: { status: number | null }, w: World) => { expect(r.status).toBe(1); untouched(w); };

    it('target profile missing from the config', () => {
      const w = makeWorld({ cloud: { launch: 'x', reap: 'y' } });
      const r = go(w, 'gke');
      fails(r, w);
      expect(r.stderr).toContain("profile 'gke' does not exist");
    });
    it('config file missing', () => {
      const w = makeWorld();
      const r = run(w, ['--to', 'gke', '--config', join(w.dir, 'nope.json'), '--log', w.daemonLog]);
      fails(r, w);
      expect(r.stderr).toContain('not found');
    });
    it('gke: kubectl cannot reach the cluster', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_KUBE_DOWN: '1' });
      fails(r, w);
      expect(r.stderr).toContain('cannot reach the cluster');
    });
    it('gke: base Secret missing', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_NO_SECRET: '1' });
      fails(r, w);
      expect(r.stderr).toContain('base Secret');
    });
    it('gke: launch line lacks HARMONY_GKE_IMAGE=', () => {
      const w = makeWorld({ gke: { ...exampleProfile, launch: exampleProfile.launch.replace(/^HARMONY_GKE_IMAGE=\S+ /, '') } });
      const r = go(w, 'gke');
      fails(r, w);
      expect(r.stderr).toContain('HARMONY_GKE_IMAGE=');
    });
    it('cloud: the Cloud Run job does not exist', () => {
      const w = makeWorld();
      const r = go(w, 'cloud', [], { STUB_NO_CRJOB: '1' });
      fails(r, w);
      expect(r.stderr).toContain('Cloud Run job');
    });
    it('HARMONY_API_TOKEN unset', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { HARMONY_API_TOKEN: '' });
      fails(r, w);
      expect(r.stderr).toContain('HARMONY_API_TOKEN');
    });
    it('no daemon running', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_NO_DAEMON: '1' });
      fails(r, w);
      expect(r.stderr).toContain('no running daemon');
    });
  });

  describe('switch and adoption', () => {
    it('cloud -> gke: SIGTERMs the old daemon, starts the new one under nohup with the profile, confirms adoption from the board', () => {
      const w = makeWorld();
      const r = go(w, 'gke');
      expect(r.status).toBe(0);
      expect(calls(w, 'kill').find((c) => c[0] === '-TERM')).toEqual(['-TERM', OLD_PID]);
      expect(calls(w, 'nohup')[0]).toEqual(['node', '/plugin/dist/bin/daemon.js', '--config', w.config, '--profile', 'gke']);
      expect(r.stdout).toContain('adopted: B-1001  conduction c-111');
      expect(r.stdout).toContain('adopted: B-1002  conduction c-222');
      expect(r.stdout).not.toContain('c-333');
      // the log said nothing about takeovers: success came from the board, not a log string
      expect(r.stdout).toContain('informational only');
      expect(r.stdout).toContain('fallback: the same command with --to cloud');
    });

    it('gke -> cloud works the same way (the fallback direction)', () => {
      const w = makeWorld();
      const r = go(w, 'cloud');
      expect(r.status).toBe(0);
      expect(calls(w, 'nohup')[0].slice(-2)).toEqual(['--profile', 'cloud']);
    });

    it('MISMATCH: held conductions never move to the new daemon -> exit 4 naming them, with the fallback', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_NO_ADOPT: '1' });
      expect(r.status).toBe(4);
      expect(r.stderr).toContain('adoption NOT confirmed');
      expect(r.stderr).toContain('B-1001  conduction c-111');
      expect(r.stderr).toContain('lease holder is');
      expect(r.stderr).toContain('--to cloud');
    });

    it('MISMATCH: adopted but the heartbeat is stale -> exit 4', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_STALE_HB: '1' });
      expect(r.status).toBe(4);
      expect(r.stderr).toContain('not fresh');
    });

    it('the old daemon ignoring SIGTERM -> exit 1 and no new daemon is started', () => {
      const w = makeWorld();
      const r = go(w, 'gke', [], { STUB_IGNORE_TERM: '1' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('did not exit');
      expect(started(w)).toBe(false);
    });
  });
});
