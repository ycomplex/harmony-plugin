// B-1310: scripts/provision-figma-workspace.sh against a stub `gcloud` on PATH. No real gcloud is ever run:
// the stub logs its argv (one call per line, arguments joined by a tab) and answers `secrets describe`
// from a list of slots that already exist.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/provision-figma-workspace.sh', import.meta.url));
const WS = '00000000-0000-4000-8000-000000000000';
const CONDUCTOR_EMAIL = 'harmony-conductor@conductor-gcp-project.iam.gserviceaccount.com';
const CONNECT = 'serviceAccount:harmony-figma-connect@harmony-conductor.iam.gserviceaccount.com';
const REFRESH = 'serviceAccount:harmony-figma-refresh@harmony-conductor.iam.gserviceaccount.com';
const CONDUCTOR = `serviceAccount:${CONDUCTOR_EMAIL}`;
const ADDER = 'roles/secretmanager.secretVersionAdder';
const ACCESSOR = 'roles/secretmanager.secretAccessor';
const slot = (s: string) => `harmony-figma-ws-${WS}-${s}`;

const EXPECTED_BINDINGS = [
  [slot('grant'), CONNECT, ADDER],
  [slot('pat'), CONNECT, ADDER],
  [slot('access'), CONNECT, ADDER],
  [slot('grant'), REFRESH, ACCESSOR],
  [slot('pat'), REFRESH, ACCESSOR],
  [slot('grant'), REFRESH, ADDER],
  [slot('access'), REFRESH, ADDER],
  [slot('access'), CONDUCTOR, ACCESSOR],
  [slot('pat'), CONDUCTOR, ACCESSOR],
];

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function run(args: string[], existing: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'b1310-prov-')); roots.push(dir);
  const log = join(dir, 'gcloud.log');
  writeFileSync(join(dir, 'existing'), existing.map((s) => s + '\n').join(''));
  writeFileSync(join(dir, 'gcloud'), `#!/usr/bin/env bash
(IFS=$'\\t'; printf '%s\\n' "$*") >> "${log}"
if [ "$1" = secrets ] && [ "$2" = describe ]; then
  grep -qxF -- "$3" "${join(dir, 'existing')}" && exit 0
  exit 1
fi
exit 0
`, { mode: 0o755 });
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    timeout: 10000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
}

function flag(call: string[], name: string): string | undefined {
  const i = call.indexOf(name);
  return i >= 0 ? call[i + 1] : undefined;
}

function assertNoForbidden(calls: string[][]) {
  for (const c of calls) {
    const line = c.join(' ');
    expect(line).not.toContain('projects add-iam-policy-binding');
    expect(line).not.toContain('keys create');
    expect(line).not.toContain('versions access');
    expect(line).not.toContain('--condition');
  }
}

describe('provision-figma-workspace.sh: argument validation', () => {
  it('refuses a bad workspace id with exit 2 and calls nothing', () => {
    const r = run(['not-a-uuid', CONDUCTOR_EMAIL]);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });
  it('refuses a bad service-account email with exit 2', () => {
    expect(run([WS, 'someone@example.com']).status).toBe(2);
    expect(run([WS, 'not-an-email']).status).toBe(2);
  });
  it('refuses a third argument other than --dry-run with exit 2', () => {
    expect(run([WS, CONDUCTOR_EMAIL, '--apply']).status).toBe(2);
  });
  it('refuses missing arguments', () => {
    expect(run([]).status).not.toBe(0);
    expect(run([WS]).status).not.toBe(0);
  });
});

describe('provision-figma-workspace.sh: a real (stubbed) run', () => {
  it('creates the three slots in the vendor project and makes exactly the nine per-slot bindings', () => {
    const r = run([WS, CONDUCTOR_EMAIL]);
    expect(r.status, r.stderr).toBe(0);
    const creates = r.calls.filter((c) => c[0] === 'secrets' && c[1] === 'create');
    expect(creates.map((c) => c[2])).toEqual([slot('grant'), slot('pat'), slot('access')]);
    for (const c of creates) expect(flag(c, '--project')).toBe('harmony-conductor');
    const binds = r.calls.filter((c) => c[0] === 'secrets' && c[1] === 'add-iam-policy-binding');
    expect(binds.map((c) => [c[2], flag(c, '--member'), flag(c, '--role')])).toEqual(EXPECTED_BINDINGS);
    for (const c of binds) expect(flag(c, '--project')).toBe('harmony-conductor');
    assertNoForbidden(r.calls);
    expect(r.stdout.match(/^bound: /gm)?.length).toBe(9);
  });

  it('skips a slot that already exists', () => {
    const r = run([WS, CONDUCTOR_EMAIL], [slot('pat')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`exists:  ${slot('pat')}`);
    const created = r.calls.filter((c) => c[0] === 'secrets' && c[1] === 'create').map((c) => c[2]);
    expect(created).toEqual([slot('grant'), slot('access')]);
    expect(r.calls.filter((c) => c[1] === 'add-iam-policy-binding')).toHaveLength(9);
  });
});

describe('provision-figma-workspace.sh: --dry-run', () => {
  it('runs no mutation and prints every create and binding command', () => {
    const r = run([WS, CONDUCTOR_EMAIL, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    for (const c of r.calls) {
      expect(c[1]).not.toBe('create');
      expect(c[1]).not.toBe('add-iam-policy-binding');
    }
    assertNoForbidden(r.calls);
    for (const s of ['grant', 'pat', 'access']) {
      expect(r.stdout).toContain(`[dry-run] gcloud secrets create ${slot(s)} --project harmony-conductor`);
    }
    for (const [s, member, role] of EXPECTED_BINDINGS) {
      expect(r.stdout).toContain(
        `[dry-run] gcloud secrets add-iam-policy-binding ${s} --project harmony-conductor --member ${member} --role ${role}`,
      );
    }
    expect(r.stdout.match(/^\[dry-run\] gcloud secrets add-iam-policy-binding /gm)?.length).toBe(9);
    expect(r.stdout.match(/^would bind: /gm)?.length).toBe(9);
    expect(r.stdout).not.toContain('bound:');
  });
});
