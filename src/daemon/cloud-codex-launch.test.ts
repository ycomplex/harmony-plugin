// B-1076: cloud-worker-launch.sh's Codex branch, EXECUTED end to end against a stub `gcloud` that records
// argv one argument per line (and the per-execution env-vars file at `update` time).
//
//   * A Claude run's gcloud calls and env file are byte-identical to the pre-B-1076 script, which is kept
//     as a fixture (fixtures/cloud-worker-launch.pre-b1076.sh — the script at 9666732) and run beside it.
//   * A Codex run first checks the job definition (`gcloud run jobs describe`) for a SECRET volume mounted
//     at /home/worker/.codex-auth-src; absent, unreadable or failing ⇒ refusal, nothing minted, no
//     update/execute. Present ⇒ the same calls as a Claude run, preceded by the describe, and the env file
//     gains HARMONY_CODEX_AUTH_FILE (a PATH).
//   * A metered variable refuses a Codex run before any gcloud call.
// The adapter probe runs on the real node.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const SCRIPT = join(REPO, 'container/cloud-worker-launch.sh');
const PRE_B1076 = fileURLToPath(new URL('./fixtures/cloud-worker-launch.pre-b1076.sh', import.meta.url));

function has(cmd: string): boolean {
  try {
    execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CAPABLE = has('bash') && has('jq');

const CID = 'cond-b1076-cloud';
const TICKET = 'B-1076';
const CODEX_RC = Buffer.from('{"agent":{"adapter":"codex"}}').toString('base64');

const jobWith = (mounts: Array<{ name: string; mountPath: string }>, volumes: Array<Record<string, unknown>>) =>
  JSON.stringify({ spec: { template: { spec: { template: { spec: { containers: [{ image: 'x', volumeMounts: mounts }], volumes } } } } } });
const MOUNTED = jobWith(
  [{ name: 'transcripts', mountPath: '/mnt/harmony-transcripts' }, { name: 'codex-auth', mountPath: '/home/worker/.codex-auth-src' }],
  [{ name: 'transcripts', csi: { driver: 'gcsfuse.run.googleapis.com' } }, { name: 'codex-auth', secret: { secretName: 'harmony-codex-auth', items: [{ key: 'latest', path: 'auth.json' }] } }],
);
const NOT_MOUNTED = jobWith([{ name: 'transcripts', mountPath: '/mnt/harmony-transcripts' }], [{ name: 'transcripts', csi: { driver: 'gcsfuse.run.googleapis.com' } }]);
// a NON-secret volume at the right path is not the login cache
const WRONG_KIND = jobWith([{ name: 'v', mountPath: '/home/worker/.codex-auth-src' }], [{ name: 'v', emptyDir: {} }]);

interface World {
  dir: string;
  logs: string;
  env: Record<string, string>;
}

function makeWorld(extra: Record<string, string> = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'b1076-cloud-'));
  const bin = join(dir, 'bin');
  const logs = join(dir, 'logs');
  const home = join(dir, 'home');
  for (const d of [bin, logs, home]) mkdirSync(d, { recursive: true });
  const stub = (name: string, lines: string[]) => writeFileSync(join(bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  stub('node', [
    `if [ "$1" = "-e" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
    'echo "node $*" >> "$STUB_LOGS/node.log"',
    'case "$*" in',
    '  *"figma context"*) printf \'%s\' \'{"state":"disconnected"}\'; exit 0 ;;',
    '  *mint-installation-token.mjs*)',
    '    out=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done',
    '    printf \'GIT_TOKEN=ghs_stub\\nHARMONY_RUN_CONFIG_JSON=%s\\n\' "$STUB_RC" > "$out" ;;',
    '  *) exit 1 ;;',
    'esac',
  ]);
  stub('gcloud', [
    '{ printf \'%s\\n\' "$@"; echo "--END--"; } >> "$STUB_LOGS/gcloud.log"',
    'case "$*" in',
    '  "run jobs describe"*) [ -n "${STUB_DESCRIBE_EXIT:-}" ] && exit "$STUB_DESCRIBE_EXIT"; printf \'%s\' "$STUB_DESCRIBE_JSON" ;;',
    '  "run jobs update"*) for a in "$@"; do case "$a" in --env-vars-file=*) cp "${a#--env-vars-file=}" "$STUB_LOGS/env-vars.yaml" ;; esac; done ;;',
    '  "run jobs executions list"*) echo exec-1 ;;',
    '  *"value(status.completionTime)"*) echo 2026-10-16T00:00:00Z ;;',
    '  *"executions describe"*) echo \'{"status":{"succeededCount":1,"completionTime":"2026-10-16T00:00:00Z"}}\' ;;',
    'esac',
  ]);
  stub('sleep', ['exit 0']);
  return {
    dir,
    logs,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      HARMONY_PLUGIN_DIR: join(dir, 'plugin'), // no dist/ — the config reads are skipped, as on a fresh checkout
      STUB_LOGS: logs,
      HARMONY_CLOUD_LAUNCH_LOCK_DIR: join(dir, 'lock'),
      HARMONY_CLOUD_LAUNCH_POLL_S: '0',
      ...extra,
    },
  };
}

function launch(w: World, script: string, rc: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, CID, TICKET, rc, 'some-model'], { encoding: 'utf8', env: { ...w.env, STUB_RC: rc, ...env } });
  return { status: r.status, stderr: r.stderr };
}

function gcloudCalls(w: World): string[][] {
  const p = join(w.logs, 'gcloud.log');
  if (!existsSync(p)) return [];
  // the per-world temp dir is the only path that differs between two worlds
  return readFileSync(p, 'utf8').split(w.dir).join('<WORLD>').split('--END--\n').filter((c) => c.length > 0).map((c) => c.replace(/\n$/, '').split('\n'));
}
const envFile = (w: World) => (existsSync(join(w.logs, 'env-vars.yaml')) ? readFileSync(join(w.logs, 'env-vars.yaml'), 'utf8') : '');
const isDescribe = (c: string[]) => c[0] === 'run' && c[1] === 'jobs' && c[2] === 'describe';

describe.skipIf(!CAPABLE)('cloud-worker-launch.sh — a Claude run is byte-identical to the pre-B-1076 script (EXECUTED)', () => {
  it.each([
    ['an empty run-config', 'e30='],
    ['a run-config naming claude-code explicitly', Buffer.from('{"agent":{"adapter":"claude-code"}}').toString('base64')],
  ])('%s: same gcloud argv, same env file, same exit', (_l, rc) => {
    const before = makeWorld();
    const after = makeWorld();
    expect(launch(before, PRE_B1076, rc).status).toBe(0);
    expect(launch(after, SCRIPT, rc).status).toBe(0);
    expect(gcloudCalls(after).map(c=>c.filter(a=>!a.startsWith("--remove-secrets=")))).toEqual(gcloudCalls(before));
    expect(gcloudCalls(after).some(isDescribe)).toBe(false);
    expect(envFile(after).replace(/^HARMONY_FIGMA_CONTEXT_B64:.*\n/m, "")).toBe(envFile(before));
    expect(envFile(after)).not.toContain('HARMONY_CODEX_AUTH_FILE');
  });

  it('the fixture IS the pre-B-1076 script (no Codex branch) — guard the guard', () => {
    const pre = readFileSync(PRE_B1076, 'utf8');
    expect(pre).not.toContain('CODEX_RUN');
    expect(pre).toContain('write_exec_env_file');
  });
});

describe.skipIf(!CAPABLE)('cloud-worker-launch.sh — B-1149 HARMONY_TEST_FORCE_REFUSAL pass-through (EXECUTED)', () => {
  it('unset / empty / garbage: absent and byte-identical; quota and rate-limit: forwarded into the env file', () => {
    const base = makeWorld();
    expect(launch(base, SCRIPT, 'e30=').status).toBe(0);
    expect(envFile(base)).not.toContain('HARMONY_TEST_FORCE_REFUSAL');
    for (const v of ['', 'garbage', 'QUOTA']) {
      const w = makeWorld();
      expect(launch(w, SCRIPT, 'e30=', { HARMONY_TEST_FORCE_REFUSAL: v }).status).toBe(0);
      expect(envFile(w)).toBe(envFile(base));
      expect(gcloudCalls(w)).toEqual(gcloudCalls(base));
    }
    for (const v of ['quota', 'rate-limit']) {
      const w = makeWorld();
      expect(launch(w, SCRIPT, 'e30=', { HARMONY_TEST_FORCE_REFUSAL: v }).status).toBe(0);
      expect(envFile(w)).toContain(`HARMONY_TEST_FORCE_REFUSAL: "${v}"`);
      expect(envFile(w).replace(`HARMONY_TEST_FORCE_REFUSAL: "${v}"\n`, '')).toBe(envFile(base));
    }
  });
});

describe.skipIf(!CAPABLE)('cloud-worker-launch.sh — the Codex adapter (B-1076, EXECUTED)', () => {
  it('secret mounted: describe first, then the Claude-run calls unchanged, and the env file carries HARMONY_CODEX_AUTH_FILE', () => {
    const claude = makeWorld();
    const codex = makeWorld({ STUB_DESCRIBE_JSON: MOUNTED });
    expect(launch(claude, SCRIPT, 'e30=').status).toBe(0);
    const r = launch(codex, SCRIPT, CODEX_RC);
    expect(r.status).toBe(0);
    const calls = gcloudCalls(codex);
    expect(calls[0]).toEqual(['run', 'jobs', 'describe', 'harmony-build-worker', '--region=us-central1', '--format=json']);
    expect(calls.slice(1)).toEqual(gcloudCalls(claude));
    expect(envFile(codex)).toContain('HARMONY_CODEX_AUTH_FILE: "/home/worker/.codex-auth-src/auth.json"');
    expect(envFile(codex).replace('HARMONY_CODEX_AUTH_FILE: "/home/worker/.codex-auth-src/auth.json"\n', '').replace(`HARMONY_RUN_CONFIG_JSON: "${CODEX_RC}"`, 'HARMONY_RUN_CONFIG_JSON: "e30="')).toBe(envFile(claude));
  });

  it.each([
    ['no volume at the mount path', { STUB_DESCRIBE_JSON: NOT_MOUNTED }, 'no secret volume mounted at /home/worker/.codex-auth-src'],
    ['a NON-secret volume at the mount path', { STUB_DESCRIBE_JSON: WRONG_KIND }, 'no secret volume mounted'],
    ['an unparseable describe', { STUB_DESCRIBE_JSON: 'not json' }, 'no secret volume mounted'],
    ['a failing describe', { STUB_DESCRIBE_EXIT: '2' }, 'cannot be confirmed'],
  ])('REFUSES on %s — names the runbook, mints nothing, never updates or executes', (_l, env, msg) => {
    const w = makeWorld(env as Record<string, string>);
    const r = launch(w, SCRIPT, CODEX_RC);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing to start');
    expect(r.stderr).toContain(msg);
    if (!('STUB_DESCRIBE_EXIT' in env)) expect(r.stderr).toContain('Codex credential runbook');
    const calls = gcloudCalls(w);
    expect(calls).toHaveLength(1);
    expect(isDescribe(calls[0])).toBe(true);
    expect(existsSync(join(w.logs, 'node.log')) ? readFileSync(join(w.logs, 'node.log'), 'utf8') : '').not.toContain('mint-installation-token');
  });

  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'])('REFUSES when %s is set — before any gcloud call, without echoing it', (name) => {
    const w = makeWorld({ STUB_DESCRIBE_JSON: MOUNTED });
    const r = launch(w, SCRIPT, CODEX_RC, { [name]: 'sk-not-echoed-456' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(name);
    expect(r.stderr).not.toContain('sk-not-echoed');
    expect(gcloudCalls(w)).toEqual([]);
  });

  it('a metered variable does not touch a Claude run', () => {
    const w = makeWorld();
    expect(launch(w, SCRIPT, 'e30=', { OPENAI_API_KEY: 'sk-x' }).status).toBe(0);
  });
});
