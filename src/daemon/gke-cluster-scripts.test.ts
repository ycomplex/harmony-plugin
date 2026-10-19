// B-1163: the GKE leg-pool setup script (container/gke/setup-cluster.sh) and the ticket-disk sweep
// (container/gke/sweep-ticket-disks.sh), EXECUTED for real from disk.
//
// Same discipline as src/daemon/docker-host-profile.test.ts: the real scripts run with stub
// executables first on PATH, never a hand-retyped copy of them. The stubs record their argv ONE
// ARGUMENT PER LINE, and the gcloud / kubectl stubs are STATEFUL (a throwaway state dir gets a marker
// file when a `create` call happens), so a second run against the same state sees things as existing.
//
// What this deliberately does NOT prove: anything about real GCP or a real cluster. No gcloud or
// kubectl is ever run here; the verify walk runs the setup script live.
//
// (This file lives under src/ only because vitest.config.ts includes src/**/*.test.ts.)

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

const setupPath = repoPath('container/gke/setup-cluster.sh');
const sweepPath = repoPath('container/gke/sweep-ticket-disks.sh');

// Capability probe keyed on what this host can run: these scripts need bash plus a few coreutils/awk.
const TOOLS = ['bash', 'mktemp', 'rm', 'cat', 'tr', 'grep', 'awk', 'dirname'];
function resolveTool(name: string): string | null {
  try {
    return execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
const RESOLVED = Object.fromEntries(TOOLS.map((t) => [t, resolveTool(t)])) as Record<string, string | null>;
const CAPABLE = TOOLS.every((t) => RESOLVED[t]);

const SENTINEL = 'SENTINEL-SECRET-VALUE-must-not-leak-9f8e7d6c';
const SA = 'daemon@proj-x.iam.gserviceaccount.com';

interface World {
  dir: string;
  bin: string;
  state: string;
  logs: string;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'b1163-gke-'));
  const world: World = { dir, bin: join(dir, 'bin'), state: join(dir, 'state'), logs: join(dir, 'logs') };
  for (const d of [world.bin, world.state, world.logs]) mkdirSync(d, { recursive: true });
  const stub = (name: string, lines: string[]) =>
    writeFileSync(join(world.bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  const record = (name: string) => `{ printf '%s\\n' "$@"; echo "--END--"; } >> "$STUB_LOGS/${name}.log"`;

  stub('gcloud', [
    record('gcloud'),
    'case " $* " in',
    '  *" container clusters describe "*) [ -f "$STUB_STATE/cluster" ] || { echo "ERROR: not found" >&2; exit 1; }; exit 0 ;;',
    '  *" container clusters create "*) touch "$STUB_STATE/cluster"; exit 0 ;;',
    '  *" container clusters get-credentials "*) exit 0 ;;',
    '  *" container node-pools describe "*)',
    '    [ -f "$STUB_STATE/pool" ] || { echo "ERROR: not found" >&2; exit 1; }',
    '    case " $* " in',
    '      *" --flatten=config.taints[] "*) [ -n "${STUB_POOL_NO_TAINT:-}" ] || printf \'harmony-leg\\ttrue\\tNO_SCHEDULE\\n\' ;;',
    '      *--format=*) printf \'%s\\t%s\\t%s\\t%s\\n\' "${STUB_POOL_MT:-e2-standard-8}" "${STUB_POOL_DT:-pd-standard}" "" "${STUB_POOL_MAX:-2}" ;;',
    '    esac; exit 0 ;;',
    '  *" container node-pools create "*) touch "$STUB_STATE/pool"; exit 0 ;;',
    '  *" compute regions describe "*) printf \'%s\\t%s\\n\' "${STUB_QUOTA_USAGE:-100.0}" "${STUB_QUOTA_LIMIT:-500.0}"; exit 0 ;;',
    '  *" secrets describe "*) case " ${STUB_MISSING_SECRETS:-} " in *" $3 "*) echo "NOT_FOUND" >&2; exit 1 ;; esac; echo "$3"; exit 0 ;;',
    `  *" secrets versions access "*) printf '%s' '${SENTINEL}'; exit 0 ;;`,
    '  *" projects get-iam-policy "*) [ -f "$STUB_STATE/iam" ] && echo roles/container.developer; exit 0 ;;',
    '  *" projects add-iam-policy-binding "*) touch "$STUB_STATE/iam"; exit 0 ;;',
    '  *" config get-value project "*) echo "${STUB_CONFIG_PROJECT:-}"; exit 0 ;;',
    'esac',
    'exit 0',
  ]);

  stub('kubectl', [
    record('kubectl'),
    'echo "${KUBECONFIG:-}" >> "$STUB_LOGS/kubeconfig.log"',
    'if [ -n "${KUBECONFIG:-}" ] && [ -f "$KUBECONFIG" ]; then echo yes >> "$STUB_LOGS/kubeconfig-existed.log"; fi',
    'case " $* " in',
    '  *" get namespace "*) [ -f "$STUB_STATE/ns" ] || exit 1; exit 0 ;;',
    '  *" create namespace "*) touch "$STUB_STATE/ns"; exit 0 ;;',
    '  *" create secret generic "*) echo "kind: Secret"; exit 0 ;;',
    '  *" apply "*) cat > /dev/null; exit 0 ;;',
    '  *" get pvc "*) printf \'%s\\n\' "${STUB_PVCS:-}"; exit 0 ;;',
    '  *" get pods "*) printf \'%s\\n\' "${STUB_MOUNTED:-}"; exit 0 ;;',
    '  *" delete pvc "*) exit 0 ;;',
    'esac',
    'exit 0',
  ]);

  stub('gke-gcloud-auth-plugin', ['exit 0']);

  // harmony --json tasks get <ID>: the answer comes from STUB_TASK_<ID with - as _>; unset = failure.
  stub('harmony', [
    record('harmony'),
    'var="STUB_TASK_${4//-/_}"',
    '[ -n "${!var:-}" ] || { echo "task not found" >&2; exit 1; }',
    'printf \'%s\' "${!var}"',
  ]);
  return world;
}

function resetLogs(world: World): void {
  for (const f of ['gcloud', 'kubectl', 'harmony', 'kubeconfig', 'kubeconfig-existed']) {
    writeFileSync(join(world.logs, `${f}.log`), '');
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function exec(world: World, script: string, args: string[], env: Record<string, string> = {}, path?: string): RunResult {
  const result = spawnSync(RESOLVED.bash!, [script, ...args], {
    encoding: 'utf8',
    // A MINIMAL environment on purpose: nothing from the developer's own shell (a real
    // CLOUDSDK_CORE_PROJECT, a real KUBECONFIG) may leak into these runs.
    env: {
      PATH: path ?? `${world.bin}:${process.env.PATH}`,
      HOME: join(world.dir, 'home'),
      STUB_LOGS: world.logs,
      STUB_STATE: world.state,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function setup(world: World, extra: string[] = [], env: Record<string, string> = {}, path?: string): RunResult {
  return exec(world, setupPath, ['--project', 'proj-x', '--daemon-sa', SA, ...extra], env, path);
}

function log(world: World, name: string): string {
  const p = join(world.logs, `${name}.log`);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Every stub invocation, each as its real argv array. */
function calls(world: World, name: string): string[][] {
  return log(world, name)
    .split('--END--\n')
    .filter((c) => c.length > 0)
    .map((c) => c.replace(/\n$/, '').split('\n'));
}

const has = (call: string[], ...words: string[]) => words.every((w) => call.includes(w));
const flagValue = (call: string[], flag: string) => call[call.indexOf(flag) + 1];
const findCall = (list: string[][], ...words: string[]) => list.find((c) => has(c, ...words));
const fromFileKeys = (call: string[]) =>
  call.filter((a) => a.startsWith('--from-file=')).map((a) => a.slice('--from-file='.length).split('=')[0]);

/** Calls that change anything: create / update / delete / IAM binding / Secret apply. */
function mutating(world: World): string[][] {
  const g = calls(world, 'gcloud').filter((c) => c.some((a) => ['create', 'update', 'delete', 'add-iam-policy-binding'].includes(a)) && !has(c, 'secrets', 'describe'));
  const k = calls(world, 'kubectl').filter((c) => c.some((a) => ['create', 'apply', 'delete'].includes(a)));
  return [...g, ...k];
}

describe.skipIf(!CAPABLE)('both scripts parse and are executable', () => {
  it.each([setupPath, sweepPath])('%s passes bash -n and has the executable bit', (path) => {
    expect(spawnSync(RESOLVED.bash!, ['-n', path], { encoding: 'utf8' }).status).toBe(0);
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });
});

describe.skipIf(!CAPABLE)('container/gke/setup-cluster.sh (EXECUTED against stub gcloud / kubectl)', () => {
  it('a fresh run creates the cluster, the pool, the namespace, the IAM binding and both Secrets', () => {
    const world = makeWorld();
    const r = setup(world);
    expect(r.status).toBe(0);

    const g = calls(world, 'gcloud');
    const cluster = findCall(g, 'container', 'clusters', 'create')!;
    expect(cluster).toBeDefined();
    expect(cluster[cluster.indexOf('create') + 1]).toBe('harmony-legs');
    expect(flagValue(cluster, '--disk-type')).toBe('pd-standard');
    expect(cluster).toContain('--enable-image-streaming');

    const pool = findCall(g, 'container', 'node-pools', 'create')!;
    expect(pool).toBeDefined();
    expect(flagValue(pool, '--disk-type')).toBe('pd-standard');
    expect(flagValue(pool, '--node-taints')).toBe('harmony-leg=true:NoSchedule');
    expect(flagValue(pool, '--min-nodes')).toBe('0');
    expect(flagValue(pool, '--max-nodes')).toBe('2');
    expect(flagValue(pool, '--num-nodes')).toBe('0');
    expect(flagValue(pool, '--machine-type')).toBe('e2-standard-8');
    expect(pool).toContain('--enable-autoscaling');
    expect(pool).toContain('--enable-image-streaming');

    const iam = findCall(g, 'projects', 'add-iam-policy-binding')!;
    expect(iam).toContain(`--member=serviceAccount:${SA}`);
    expect(iam).toContain('--role=roles/container.developer');

    const k = calls(world, 'kubectl');
    expect(findCall(k, 'create', 'namespace', 'harmony-legs')).toBeDefined();
    expect(findCall(k, 'create', 'secret', 'generic', 'harmony-worker-secrets')).toBeDefined();
    expect(findCall(k, 'create', 'secret', 'generic', 'harmony-codex-auth')).toBeDefined();
    expect(k.filter((c) => has(c, 'apply'))).toHaveLength(2);
    expect(r.stdout).toContain('cluster:        harmony-legs');
  });

  it('a second run against the same state makes NO create / IAM-binding / namespace call — only reads and the idempotent Secret apply', () => {
    const world = makeWorld();
    expect(setup(world).status).toBe(0);
    resetLogs(world);

    const second = setup(world);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('cluster harmony-legs: exists, left unchanged');
    const g = calls(world, 'gcloud');
    expect(g.some((c) => has(c, 'create'))).toBe(false);
    expect(g.some((c) => has(c, 'add-iam-policy-binding'))).toBe(false);
    const k = calls(world, 'kubectl');
    expect(k.some((c) => has(c, 'create', 'namespace'))).toBe(false);
    // the only kubectl `create` left is the client-side dry-run that feeds `kubectl apply`
    for (const c of k.filter((x) => has(x, 'create'))) {
      expect(c).toContain('--dry-run=client');
      expect(has(c, 'secret', 'generic')).toBe(true);
    }
    expect(k.filter((c) => has(c, 'apply'))).toHaveLength(2);
  });

  it('--dry-run never invokes a stub, prints the whole create path, and works with no gcloud / kubectl on PATH', () => {
    const world = makeWorld();
    resetLogs(world);
    const r = setup(world, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(log(world, 'gcloud')).toBe('');
    expect(log(world, 'kubectl')).toBe('');
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('[dry-run]'));
    const text = lines.join('\n');
    for (const needle of [
      'gcloud container clusters create harmony-legs',
      'gcloud container node-pools create legs',
      'gcloud container clusters get-credentials harmony-legs',
      'kubectl create namespace harmony-legs',
      'gcloud projects add-iam-policy-binding proj-x',
      'kubectl -n harmony-legs create secret generic harmony-worker-secrets',
      'kubectl -n harmony-legs create secret generic harmony-codex-auth',
    ]) {
      expect(text).toContain(needle);
    }

    // a PATH holding only the coreutils the script itself needs — no gcloud, no kubectl, no stubs
    const bare = join(world.dir, 'bare');
    mkdirSync(bare);
    for (const t of TOOLS) symlinkSync(RESOLVED[t]!, join(bare, t));
    const noTools = setup(world, ['--dry-run'], {}, bare);
    expect(noTools.status).toBe(0);
    expect(noTools.stdout).toContain('[dry-run] gcloud container clusters create harmony-legs');
    // …whereas a real run on that PATH names the missing tool and stops
    const real = setup(world, [], {}, bare);
    expect(real.status).toBe(1);
    expect(real.stderr).toContain("'gcloud' is not on PATH");
  });

  it('a secret value NEVER reaches stdout, stderr or any recorded argv — only Secret and key NAMES are printed', () => {
    const world = makeWorld();
    const r = setup(world);
    expect(r.status).toBe(0);
    // the stub really did hand the sentinel out (positive control)…
    expect(findCall(calls(world, 'gcloud'), 'secrets', 'versions', 'access')).toBeDefined();
    // …and it appears nowhere observable
    for (const text of [r.stdout, r.stderr, log(world, 'gcloud'), log(world, 'kubectl')]) {
      expect(text).not.toContain(SENTINEL);
    }
    for (const name of ['harmony-worker-secrets', 'harmony-codex-auth', 'HARMONY_API_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'auth.json']) {
      expect(r.stdout).toContain(name);
    }
  });

  it('splits the Secrets: the env Secret carries exactly the two tokens, the file Secret only auth.json', () => {
    const world = makeWorld();
    expect(setup(world).status).toBe(0);
    const creates = calls(world, 'kubectl').filter((c) => has(c, 'create', 'secret', 'generic'));
    expect(creates).toHaveLength(2);
    const env = creates.find((c) => c.includes('harmony-worker-secrets'))!;
    const file = creates.find((c) => c.includes('harmony-codex-auth'))!;
    expect(fromFileKeys(env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'HARMONY_API_TOKEN']);
    expect(env.join('\n')).not.toContain('auth.json');
    expect(fromFileKeys(file)).toEqual(['auth.json']);
    expect(file.join('\n')).not.toContain('HARMONY_API_TOKEN');
    expect(file).toContain('--dry-run=client');
  });

  it('--no-codex: one Secret only, and Secret Manager is never asked about the Codex secret', () => {
    const world = makeWorld();
    const r = setup(world, ['--no-codex']);
    expect(r.status).toBe(0);
    const creates = calls(world, 'kubectl').filter((c) => has(c, 'create', 'secret', 'generic'));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('harmony-worker-secrets');
    const g = calls(world, 'gcloud');
    expect(g.some((c) => c.includes('--secret=harmony-codex-auth'))).toBe(false);
    expect(g.some((c) => has(c, 'secrets', 'describe') && c.includes('harmony-codex-auth'))).toBe(false);
    expect(r.stdout).not.toContain('auth.json');
  });

  it('an existing cluster with a DRIFTED pool: nothing is created, updated or deleted; DRIFT: lines are printed; exit 0', () => {
    const world = makeWorld();
    writeFileSync(join(world.state, 'cluster'), '');
    writeFileSync(join(world.state, 'pool'), '');
    const r = setup(world, [], { STUB_POOL_MT: 'n1-standard-4', STUB_POOL_DT: 'pd-ssd', STUB_POOL_MAX: '5', STUB_POOL_NO_TAINT: '1' });
    expect(r.status).toBe(0);
    const g = calls(world, 'gcloud');
    expect(g.some((c) => c.some((a) => ['create', 'update', 'delete', 'resize', 'upgrade'].includes(a)) && c.includes('container'))).toBe(false);
    const drift = r.stdout.split('\n').filter((l) => l.startsWith('DRIFT:'));
    expect(drift.join('\n')).toContain('machine type');
    expect(drift.join('\n')).toContain('disk type');
    expect(drift.join('\n')).toContain('max nodes');
    expect(drift.join('\n')).toContain('taint');
    expect(drift.length).toBe(4);
    // and an undrifted pool reports none
    const clean = setup(world);
    expect(clean.status).toBe(0);
    expect(clean.stdout).not.toContain('DRIFT:');
  });

  it('a missing Secret Manager secret fails BEFORE any mutating call or secret access', () => {
    const world = makeWorld();
    const r = setup(world, [], { STUB_MISSING_SECRETS: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(mutating(world)).toEqual([]);
    expect(calls(world, 'gcloud').some((c) => has(c, 'secrets', 'versions'))).toBe(false);
    expect(existsSync(join(world.state, 'cluster'))).toBe(false);
  });

  it('prints the quota line, and warns under 100 GB of headroom without failing', () => {
    const world = makeWorld();
    const ok = setup(world, [], { STUB_QUOTA_USAGE: '100.0', STUB_QUOTA_LIMIT: '500.0' });
    expect(ok.stdout).toContain('SSD_TOTAL_GB: 100.0 of 500.0 GB used in us-central1');
    expect(ok.stdout).not.toContain('WARNING');
    const low = setup(makeWorld(), [], { STUB_QUOTA_USAGE: '10.0', STUB_QUOTA_LIMIT: '100.0' });
    expect(low.status).toBe(0);
    expect(low.stdout).toContain('WARNING');
    expect(low.stdout).toContain('request an SSD_TOTAL_GB quota increase');
    const skipped = makeWorld();
    expect(setup(skipped, ['--skip-quota-check']).status).toBe(0);
    expect(calls(skipped, 'gcloud').some((c) => has(c, 'compute'))).toBe(false);
  });

  it('a missing required flag exits 2 with usage; the default cluster is not the hand-made spike cluster', () => {
    const world = makeWorld();
    const r = exec(world, setupPath, ['--project', 'proj-x']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('--daemon-sa');
    expect(exec(world, setupPath, ['--project', 'p', '--daemon-sa', SA, '--bogus']).status).toBe(2);
    const noProject = exec(world, setupPath, ['--daemon-sa', SA]);
    expect(noProject.status).toBe(2);
    expect(noProject.stderr).toContain('--project');

    const help = exec(world, setupPath, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('[harmony-legs]');
    expect(help.stdout).not.toContain('harmony-pool-spike');
    expect(readFileSync(setupPath, 'utf8')).not.toContain('harmony-pool-spike');
    // the only gcloud call a usage error may make is the project lookup
    expect(calls(world, 'gcloud').every((c) => has(c, 'config', 'get-value', 'project'))).toBe(true);
    expect(mutating(world)).toEqual([]);
  });

  it('the project falls back to CLOUDSDK_CORE_PROJECT', () => {
    const world = makeWorld();
    const r = exec(world, setupPath, ['--daemon-sa', SA, '--dry-run'], { CLOUDSDK_CORE_PROJECT: 'from-env' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--project from-env');
  });

  it('works in a TEMPORARY kubeconfig: not the operator\'s, and gone after the script exits', () => {
    const world = makeWorld();
    const own = join(world.dir, 'own-kubeconfig');
    const r = setup(world, [], { KUBECONFIG: own });
    expect(r.status).toBe(0);
    const used = [...new Set(log(world, 'kubeconfig').split('\n').filter(Boolean))];
    expect(used).toHaveLength(1);
    expect(used[0]).not.toBe(own);
    expect(used[0].startsWith(join(world.dir, 'home'))).toBe(false);
    expect(log(world, 'kubeconfig-existed').trim().split('\n').length).toBeGreaterThan(0);
    expect(existsSync(used[0])).toBe(false);
    expect(existsSync(own)).toBe(false);
  });
});

describe.skipIf(!CAPABLE)('container/gke/sweep-ticket-disks.sh (EXECUTED against stub kubectl / harmony)', () => {
  const task = (workflow_state: string, archived = false) => JSON.stringify({ workflow_state, archived });
  const PVCS = [
    'ticket-b-1001', // Verified -> delete
    'ticket-b-1002', // Cancelled -> delete
    'ticket-b-1003', // archived -> delete
    'ticket-b-1004', // In Progress -> keep
    'ticket-b-1005', // Parked -> keep
    'data-cache', // not a ticket disk -> never touched
    'ticket-b-1006', // Verified but still mounted -> keep
  ];
  const TASKS: Record<string, string> = {
    STUB_TASK_B_1001: task('Verified'),
    STUB_TASK_B_1002: task('Cancelled'),
    STUB_TASK_B_1003: task('In Progress', true),
    STUB_TASK_B_1004: task('In Progress'),
    STUB_TASK_B_1005: task('Parked'),
    STUB_TASK_B_1006: task('Verified'),
  };
  const sweep = (world: World, pvcs: string[], args: string[] = [], env: Record<string, string> = {}) =>
    exec(world, sweepPath, args, { STUB_PVCS: pvcs.join('\n'), STUB_MOUNTED: 'ticket-b-1006\nsomething-else', ...TASKS, ...env });
  const deletes = (world: World) => calls(world, 'kubectl').filter((c) => has(c, 'delete')).map((c) => c[c.indexOf('pvc') + 1]);

  it('deletes Verified, Cancelled and archived tickets\' disks; keeps In Progress, Parked, mounted and non-ticket PVCs', () => {
    const world = makeWorld();
    const r = sweep(world, PVCS);
    expect(r.status).toBe(0);
    expect(deletes(world)).toEqual(['ticket-b-1001', 'ticket-b-1002', 'ticket-b-1003']);
    const del = calls(world, 'kubectl').find((c) => has(c, 'delete'))!;
    expect(del).toEqual(['-n', 'harmony-legs', 'delete', 'pvc', 'ticket-b-1001', '--wait=false']);
    expect(r.stdout).toContain('keep ticket-b-1004 (B-1004): state In Progress');
    expect(r.stdout).toContain('keep ticket-b-1005 (B-1005): state Parked');
    expect(r.stdout).toContain('mounted by a running pod');
    expect(r.stdout).toContain('deleted 3, kept 3, skipped 1');
    // the non-ticket PVC is never asked about and never deleted; a mounted PVC's ticket is not read
    expect(r.stdout).not.toContain('data-cache');
    const asked = calls(world, 'harmony').map((c) => c[c.indexOf('get') + 1]);
    expect(asked).toEqual(['B-1001', 'B-1002', 'B-1003', 'B-1004', 'B-1005']);
    expect(calls(world, 'harmony')[0].slice(0, 3)).toEqual(['--json', 'tasks', 'get']);
  });

  it('FAILS CLOSED: a ticket whose state cannot be read keeps its disk, warns, and ends with exit 3 after the rest', () => {
    const world = makeWorld();
    const r = sweep(world, ['ticket-b-1007', 'ticket-b-1001', 'ticket-b-1008'], [], { STUB_TASK_B_1008: 'not json at all' });
    expect(r.status).toBe(3);
    expect(deletes(world)).toEqual(['ticket-b-1001']);
    expect(r.stderr).toContain('ticket-b-1007');
    expect(r.stderr).toContain('ticket-b-1008');
    expect(r.stdout).toContain('deleted 1, kept 2');
  });

  it('--dry-run deletes nothing and prints the delete it would run', () => {
    const world = makeWorld();
    const r = sweep(world, PVCS, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(deletes(world)).toEqual([]);
    expect(r.stdout).toContain('[dry-run] kubectl -n harmony-legs delete pvc ticket-b-1001 --wait=false');
  });

  it('honours --namespace and $HARMONY_GKE_NAMESPACE', () => {
    const a = makeWorld();
    sweep(a, ['ticket-b-1001'], ['--namespace', 'other-ns']);
    expect(calls(a, 'kubectl')[0].slice(0, 2)).toEqual(['-n', 'other-ns']);
    const b = makeWorld();
    sweep(b, ['ticket-b-1001'], [], { HARMONY_GKE_NAMESPACE: 'env-ns' });
    expect(calls(b, 'kubectl')[0].slice(0, 2)).toEqual(['-n', 'env-ns']);
  });

  it('uses node $HARMONY_PLUGIN_DIR/dist/bin/harmony.js when HARMONY_PLUGIN_DIR is set', () => {
    const world = makeWorld();
    const plugin = join(world.dir, 'plugin');
    mkdirSync(join(plugin, 'dist', 'bin'), { recursive: true });
    writeFileSync(
      join(plugin, 'dist', 'bin', 'harmony.js'),
      `process.stdout.write(JSON.stringify({ workflow_state: 'Verified', archived: false }));\n`,
    );
    const r = sweep(world, ['ticket-b-1001'], [], { HARMONY_PLUGIN_DIR: plugin });
    expect(r.status).toBe(0);
    expect(deletes(world)).toEqual(['ticket-b-1001']);
    expect(calls(world, 'harmony')).toEqual([]); // the PATH stub was not used
  });

  it('rejects an unknown flag with usage on stderr (exit 2)', () => {
    const r = exec(makeWorld(), sweepPath, ['--nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });
});
