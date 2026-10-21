// B-1161: the gke profile's launch / probe / reap scripts, EXECUTED against a stub `kubectl` that records
// argv one argument per line. Real node and real bash; the mint script is a stub in a temp plugin dir.
//
// Stub scenario knobs (env): STUB_JOB_SEQ / STUB_PODS_SEQ are JSON arrays of responses served one per
// `get job -o json` / `get pods -o json` call (the last repeats). A response is an object (served as
// JSON), the string "ERR" (kubectl fails, Job still exists), "GONE" (NotFound) or "GARBAGE".

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const LAUNCH = join(REPO, 'container/gke/gke-worker-launch.sh');
const PROBE = join(REPO, 'container/gke/gke-worker-probe.sh');
const REAP = join(REPO, 'container/gke/gke-worker-reap.sh');

const STUB_KUBECTL = fileURLToPath(new URL('./fixtures/stub-kubectl-gke.sh', import.meta.url));

const CAPABLE = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v bash'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const CID = 'cond1234-b1161-gke';
const TICKET = 'B-1161';
const CODEX_RC = Buffer.from('{"agent":{"adapter":"codex"}}').toString('base64');
const SECRET_VALUE = 'ghs_stub_secret_value';

const ACTIVE = { metadata: { name: 'j' }, status: { active: 1 } };
const COMPLETE = { metadata: { name: 'j' }, status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } };
const FAILED = { metadata: { name: 'j' }, status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] } };
const FAILED_BACKOFF = { metadata: { name: 'j' }, status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } };
const pod = (extra: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
  items: [{ metadata: { name: 'leg-pod', ...extra }, status: { phase: 'Succeeded', ...status } }],
});
const CLEAN_POD = pod();

interface World {
  dir: string;
  logs: string;
  home: string;
  env: Record<string, string>;
}

function makeWorld(extra: Record<string, string> = {}, opts: { workerImage?: string } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'b1161-gke-'));
  const bin = join(dir, 'bin');
  const logs = join(dir, 'logs');
  const home = join(dir, 'home');
  const plugin = join(dir, 'plugin');
  for (const d of [bin, logs, home, join(plugin, 'scripts'), join(plugin, 'dist/bin')]) mkdirSync(d, { recursive: true });
  // mint stub: writes the --out env file
  writeFileSync(
    join(plugin, 'scripts/mint-installation-token.mjs'),
    `import { writeFileSync } from 'node:fs';
const a = process.argv; const out = a[a.indexOf('--out') + 1];
writeFileSync(out, 'GIT_TOKEN=${SECRET_VALUE}\\nHARMONY_RUN_CONFIG_JSON=' + a[a.indexOf('--run-config') + 1] + '\\n');
`,
  );
  // `harmony config get <key>` stub
  writeFileSync(
    join(plugin, 'dist/bin/harmony.js'),
    `const k = process.argv[4]; if (k === 'worker_image' && process.env.STUB_WORKER_IMAGE) process.stdout.write(process.env.STUB_WORKER_IMAGE);\n`,
  );
  const kubectl = readFileSync(STUB_KUBECTL, 'utf8');
  writeFileSync(join(bin, 'kubectl'), kubectl, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return {
    dir,
    logs,
    home,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      HARMONY_PLUGIN_DIR: plugin,
      STUB_LOGS: logs,
      HARMONY_GKE_POLL_S: '0',
      ...(opts.workerImage ? { STUB_WORKER_IMAGE: opts.workerImage } : {}),
      ...extra,
    },
  };
}

const run = (w: World, script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...w.env, ...env } });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
};
const launch = (w: World, env: Record<string, string> = {}, rc = '{}') => run(w, LAUNCH, [CID, TICKET, rc, 'some-model'], env);
const seq = (jobs: unknown[], pods?: unknown[]) => ({ STUB_JOB_SEQ: JSON.stringify(jobs), ...(pods ? { STUB_PODS_SEQ: JSON.stringify(pods) } : {}) });

function calls(w: World): string[][] {
  const p = join(w.logs, 'kubectl.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('--END--\n').filter((c) => c.length > 0).map((c) => c.replace(/\n$/, '').split('\n'));
}
const verbs = (w: World) => calls(w).map((c) => c.join(' '));
const read = (w: World, f: string) => (existsSync(join(w.logs, f)) ? readFileSync(join(w.logs, f), 'utf8') : '');
const podReads = (w: World) => read(w, 'pods-reads').split('\n').filter(Boolean).length;
const minted = (w: World) => existsSync(join(w.home, '.harmony-conductions', TICKET, CID, 'run.env'));

describe.skipIf(!CAPABLE)('gke-worker-launch.sh — the ticket-disk storage class', () => {
  it('falls back to standard-rwo, with a line saying so, on a cluster without harmony-ticket-disk', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { STUB_NO_TICKET_SC: '1' });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(w, 'pvc.json')).spec.storageClassName).toBe('standard-rwo');
    expect(r.stderr).toContain('storage class harmony-ticket-disk not found; using standard-rwo');
  });

  it('an explicit HARMONY_GKE_STORAGE_CLASS is used as given, with no storage class read', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { HARMONY_GKE_STORAGE_CLASS: 'premium-rwo' });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(w, 'pvc.json')).spec.storageClassName).toBe('premium-rwo');
    expect(verbs(w).some((c) => c.includes('get storageclass'))).toBe(false);
  });
});

describe.skipIf(!CAPABLE)('gke-worker-launch.sh — the four steps (EXECUTED against a stub kubectl)', () => {
  it('runs apply pvc, create job, then creates the leg secret already owned by the Job, with the documented defaults', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w);
    expect(r.status).toBe(0);
    const v = verbs(w);
    const idx = (prefix: string) => v.findIndex((c) => c.includes(prefix));
    const iApply = idx('apply -f -');
    const iJob = idx('create -f -');
    const iRender = idx('create secret generic');
    expect(iApply).toBeGreaterThan(-1);
    expect(iApply).toBeLessThan(iJob);
    expect(iJob).toBeLessThan(iRender);
    // B-1173: the remote conductor may create secrets but not read them, and `kubectl patch` reads first.
    expect(v[iRender]).toContain('--dry-run=client');
    expect(v.some((c) => c.includes('patch secret'))).toBe(false);
    expect(v.filter((c) => c.includes('create -f -'))).toHaveLength(2);
    const secret = JSON.parse(read(w, 'secret.json'));
    expect(secret.kind).toBe('Secret');
    expect(secret.metadata.ownerReferences).toEqual([{ apiVersion: 'batch/v1', kind: 'Job', name: expect.stringMatching(/^leg-/), uid: 'uid-123' }]);
    // defaults via argv: namespace, base secret pre-flight
    for (const c of calls(w)) expect(c.slice(0, 2)).toEqual(['-n', 'harmony-legs']);
    expect(calls(w)[0]).toEqual(['-n', 'harmony-legs', 'get', 'secret', 'harmony-worker-secrets']);
    // ticket disk
    const pvc = JSON.parse(read(w, 'pvc.json'));
    expect(pvc.metadata.name).toBe('ticket-b-1161');
    expect(pvc.spec.storageClassName).toBe('harmony-ticket-disk'); // present on the cluster (stub default)
    expect(pvc.spec.resources.requests.storage).toBe('20Gi');
    // the Job as created: launch defaults reach the renderer
    const job = JSON.parse(read(w, 'job.json'));
    const worker = job.spec.template.spec.containers[0];
    expect(worker.resources.requests).toEqual({ cpu: '6', memory: '20Gi' });
    expect(job.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(job.spec.activeDeadlineSeconds).toBe(5400);
    expect(job.spec.template.spec.volumes[0].persistentVolumeClaim.claimName).toBe('ticket-b-1161');
    expect(worker.envFrom[0]).toEqual({ secretRef: { name: 'harmony-worker-secrets' } });
    // transcripts: the bucket (defaults) through the CSI volume, run as the default service account (B-1169)
    expect(job.spec.template.spec.serviceAccountName).toBe('harmony-leg');
    const tv = job.spec.template.spec.volumes.find((v: { name: string }) => v.name === 'transcripts');
    expect(tv.csi.volumeAttributes.bucketName).toBe('harmony-conductor-transcripts');
    expect(worker.volumeMounts).toContainEqual({ name: 'transcripts', mountPath: '/mnt/harmony-transcripts' });
    // owner reference carries the uid read from the Job (asserted on secret.json above)
  });

  it('the ticket disk name is ticket- + the lower-cased id with [^a-z0-9-] replaced by -', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    expect(run(w, LAUNCH, [CID, 'Foo_Bar.7/X', '{}']).status).toBe(0);
    expect(JSON.parse(read(w, 'pvc.json')).metadata.name).toBe('ticket-foo-bar-7-x');
  });

  it('knobs override the defaults (namespace, context, base secret, cpu, memory, ttl)', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, {
      HARMONY_GKE_NAMESPACE: 'ns-x', HARMONY_GKE_CONTEXT: 'ctx-y', HARMONY_GKE_BASE_SECRET: 'base-z',
      HARMONY_GKE_CPU: '2', HARMONY_GKE_MEMORY: '4Gi', HARMONY_GKE_JOB_TTL_S: '60',
    });
    expect(r.status).toBe(0);
    for (const c of calls(w)) expect(c.slice(0, 4)).toEqual(['-n', 'ns-x', '--context', 'ctx-y']);
    expect(calls(w)[0].slice(4)).toEqual(['get', 'secret', 'base-z']);
    const job = JSON.parse(read(w, 'job.json'));
    expect(job.spec.ttlSecondsAfterFinished).toBe(60);
    expect(job.spec.template.spec.containers[0].resources.requests).toEqual({ cpu: '2', memory: '4Gi' });
  });

  it('B-1173: in a remote conductor pod (HARMONY_CONDUCTOR_REMOTE=1) kubectl gets NO --context — there is no kubeconfig, only the pod service account', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { HARMONY_GKE_NAMESPACE: 'ns-x', HARMONY_GKE_CONTEXT: 'gke_p_l_c', HARMONY_CONDUCTOR_REMOTE: '1' });
    expect(r.status).toBe(0);
    for (const c of calls(w)) {
      expect(c.slice(0, 2)).toEqual(['-n', 'ns-x']);
      expect(c).not.toContain('--context');
    }
  });

  it('a leg secret that cannot be created deletes the Job it was for and fails the launch', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { STUB_SECRET_CREATE_FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not create the leg secret');
    expect(verbs(w).some((c) => c.includes('delete job'))).toBe(true);
    expect(existsSync(read(w, 'envfile-path').trim())).toBe(false);
  });

  it('never puts a secret value on argv; the env file is 0600 when create secret runs and gone afterwards', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    expect(launch(w).status).toBe(0);
    expect(read(w, 'kubectl.log')).not.toContain(SECRET_VALUE);
    expect(read(w, 'envfile-mode').trim()).toBe('600');
    const copy = read(w, 'envfile-copy');
    expect(copy).toContain(`GIT_TOKEN=${SECRET_VALUE}`);
    expect(copy).toContain(`CONDUCTION_ID=${CID}`);
    expect(copy).toContain(`TICKET=${TICKET}`);
    expect(copy).toContain('HARMONY_TRANSCRIPT_MOUNT_ROOT=/mnt/harmony-transcripts');
    expect(copy).toContain(`HARMONY_CONDUCTION_ID=${CID}`);
    expect(copy).not.toContain('HARMONY_CODEX_AUTH_FILE');
    expect(existsSync(read(w, 'envfile-path').trim())).toBe(false);
  });

  it('a Codex run mounts the login cache read-only, and the env file names the auth file path', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    expect(launch(w, {}, CODEX_RC).status).toBe(0);
    expect(read(w, 'envfile-copy')).toContain('HARMONY_CODEX_AUTH_FILE=/home/worker/.codex-auth-src/auth.json');
    const spec = JSON.parse(read(w, 'job.json')).spec.template.spec;
    expect(spec.volumes).toContainEqual({ name: 'codex-auth', secret: { secretName: 'harmony-codex-auth' } });
    expect(spec.containers[0].volumeMounts).toContainEqual({ name: 'codex-auth', mountPath: '/home/worker/.codex-auth-src', readOnly: true });
  });
});

describe.skipIf(!CAPABLE)('gke-worker-launch.sh — refusals (before anything is minted)', () => {
  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'])('REFUSES a Codex run when %s is set — before any kubectl call, without echoing it', (name) => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { [name]: 'sk-not-echoed-456' }, CODEX_RC);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(name);
    expect(r.stderr).not.toContain('sk-not-echoed');
    expect(calls(w)).toEqual([]);
    expect(minted(w)).toBe(false);
  });

  it('a metered variable does not touch a Claude run', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    expect(launch(w, { OPENAI_API_KEY: 'sk-x' }).status).toBe(0);
  });

  it('REFUSES when the base secret is missing — names namespace/secret, creates nothing, mints nothing', () => {
    const w = makeWorld({ STUB_MISSING_SECRETS: 'harmony-worker-secrets' });
    const r = launch(w);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('harmony-legs/harmony-worker-secrets');
    expect(verbs(w).some((c) => /apply|create/.test(c))).toBe(false);
    expect(minted(w)).toBe(false);
  });

  it('REFUSES when the Kubernetes service account is missing — names it, creates nothing, mints nothing', () => {
    const w = makeWorld({ STUB_MISSING_SERVICEACCOUNTS: 'harmony-leg' });
    const r = launch(w);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('harmony-legs/harmony-leg');
    expect(verbs(w).some((c) => /apply|create/.test(c))).toBe(false);
    expect(minted(w)).toBe(false);
    expect(read(w, 'job.json')).toBe('');
  });

  it('forwards HARMONY_GKE_TRANSCRIPT_BUCKET and HARMONY_GKE_SERVICE_ACCOUNT to the renderer, and checks that service account', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const r = launch(w, { HARMONY_GKE_TRANSCRIPT_BUCKET: 'other-bucket', HARMONY_GKE_SERVICE_ACCOUNT: 'other-ksa' });
    expect(r.status).toBe(0);
    expect(verbs(w)).toContain('-n harmony-legs get serviceaccount other-ksa');
    const spec = JSON.parse(read(w, 'job.json')).spec.template.spec;
    expect(spec.serviceAccountName).toBe('other-ksa');
    expect(spec.volumes.find((v: { name: string }) => v.name === 'transcripts').csi.volumeAttributes.bucketName).toBe('other-bucket');
  });

  it('REFUSES a Codex run when the Codex secret is missing — no Job, nothing minted', () => {
    const w = makeWorld({ STUB_MISSING_SECRETS: 'harmony-codex-auth' });
    const r = launch(w, {}, CODEX_RC);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('harmony-legs/harmony-codex-auth');
    expect(verbs(w).some((c) => /apply|create/.test(c))).toBe(false);
    expect(minted(w)).toBe(false);
  });

  it('a missing Codex secret does not matter to a Claude run', () => {
    const w = makeWorld({ STUB_MISSING_SECRETS: 'harmony-codex-auth', ...seq([COMPLETE], [CLEAN_POD]) });
    expect(launch(w).status).toBe(0);
  });
});

describe.skipIf(!CAPABLE)('gke-worker-launch.sh — image precedence', () => {
  const jobImage = (w: World) => JSON.parse(read(w, 'job.json')).spec.template.spec.containers[0].image as string;
  const REG = 'us-central1-docker.pkg.dev/harmony-conductor/harmony-workers';

  it('HARMONY_GKE_IMAGE beats worker_image beats the built-in default', () => {
    const a = makeWorld(seq([COMPLETE], [CLEAN_POD]), { workerImage: 'cfg-image:1' });
    const ra = launch(a, { HARMONY_GKE_IMAGE: 'env-image:2' });
    expect(jobImage(a)).toBe(`${REG}/env-image:2`);
    expect(ra.stderr).toContain('source: HARMONY_GKE_IMAGE');

    const b = makeWorld(seq([COMPLETE], [CLEAN_POD]), { workerImage: 'cfg-image:1' });
    const rb = launch(b);
    expect(jobImage(b)).toBe(`${REG}/cfg-image:1`);
    expect(rb.stderr).toContain('source: deployment config worker_image');

    const c = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    const rc = launch(c);
    expect(jobImage(c)).toBe(`${REG}/harmony-build-env-docker:latest`);
    expect(rc.stderr).toContain('source: built-in default');
  });

  it('a value containing / is used verbatim; a bare name gets the registry prefix', () => {
    const a = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    launch(a, { HARMONY_GKE_IMAGE: 'example.io/team/img:3' });
    expect(jobImage(a)).toBe('example.io/team/img:3');
    const b = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    launch(b, { HARMONY_GKE_IMAGE: 'img:3', HARMONY_GKE_REGISTRY: 'reg.example/x' });
    expect(jobImage(b)).toBe('reg.example/x/img:3');
  });
});

describe.skipIf(!CAPABLE)('gke-worker-launch.sh — the wait loop is the exit-code contract', () => {
  it('Complete with clean pods -> 0', () => {
    const w = makeWorld(seq([COMPLETE], [CLEAN_POD]));
    expect(launch(w).status).toBe(0);
  });

  it('Failed with reason DeadlineExceeded -> 73 (B-1187), naming the reason, without reading pods', () => {
    const w = makeWorld(seq([ACTIVE, FAILED]));
    const r = launch(w);
    expect(r.status).toBe(73);
    expect(r.stderr).toContain('DeadlineExceeded');
    expect(podReads(w)).toBe(0);
  });

  it('Failed for another reason with clean pods -> 1', () => {
    const w = makeWorld(seq([ACTIVE, FAILED_BACKOFF], [pod({}, { phase: 'Failed', containerStatuses: [{ name: 'worker', state: { terminated: { reason: 'Error', exitCode: 1 } } }] })]));
    const r = launch(w);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BackoffLimitExceeded');
    expect(r.stderr).not.toContain('killed:');
  });

  it('Failed with the pod list unreadable -> 1', () => {
    expect(launch(makeWorld(seq([FAILED_BACKOFF], ['ERR']))).status).toBe(1);
    expect(launch(makeWorld(seq([FAILED_BACKOFF], ['GARBAGE']))).status).toBe(1);
  });

  // B-1187. HAND-BUILT fixtures from the Kubernetes API field paths (Pod.status.reason,
  // Pod.status.conditions[], Pod.status.containerStatuses[].state.terminated.reason, Job Failed condition
  // reason) — no real specimen was available (kubectl / a cluster were not reachable when this was written).
  it.each([
    ['pod status.reason Evicted', pod({}, { phase: 'Failed', reason: 'Evicted' }), 71, 'Evicted'],
    ['a DisruptionTarget=True condition', pod({}, { phase: 'Failed', conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'EvictionByEvictionAPI' }] }), 71, 'DisruptionTarget'],
    ['a deletionTimestamp', pod({ deletionTimestamp: '2026-10-19T00:00:00Z' }, { phase: 'Failed' }), 71, 'deleted'],
    ['an OOMKilled container (state)', pod({}, { phase: 'Failed', containerStatuses: [{ name: 'worker', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }), 72, 'OOMKilled'],
    ['an OOMKilled container (lastState)', pod({}, { phase: 'Failed', containerStatuses: [{ name: 'worker', state: {}, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }), 72, 'OOMKilled'],
    ['OOMKilled AND Evicted (72 outranks 71)', pod({}, { phase: 'Failed', reason: 'Evicted', containerStatuses: [{ name: 'worker', state: { terminated: { reason: 'OOMKilled' } } }] }), 72, 'OOMKilled'],
  ])('Failed and the pod shows %s -> %i with the reason on stderr', (_l, p, code, needle) => {
    const w = makeWorld(seq([FAILED_BACKOFF], [p]));
    const r = launch(w);
    expect(r.status).toBe(code);
    expect(r.stderr).toContain(`killed: ${needle}`);
    expect(podReads(w)).toBe(1);
  });

  it('DeadlineExceeded (73) outranks pod evidence', () => {
    const w = makeWorld(seq([FAILED], [pod({}, { reason: 'Evicted' })]));
    expect(launch(w).status).toBe(73);
  });

  it('Job gone (NotFound, confirmed by --ignore-not-found) -> 1', () => {
    const w = makeWorld(seq([ACTIVE, 'GONE']));
    const r = launch(w);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is gone');
    expect(verbs(w).some((c) => c.includes('--ignore-not-found'))).toBe(true);
  });

  it.each([['an API error', 'ERR'], ['unparsable output', 'GARBAGE']])('%s is transient: keep waiting, then Complete -> 0', (_l, bad) => {
    const w = makeWorld(seq([ACTIVE, bad, bad, COMPLETE], [CLEAN_POD]));
    expect(launch(w).status).toBe(0);
    expect(read(w, 'jobctr')).toBe('4');
  });

  it('polls with ONE get job -o json per pass (no jsonpath polling)', () => {
    const w = makeWorld(seq([ACTIVE, ACTIVE, COMPLETE], [CLEAN_POD]));
    expect(launch(w).status).toBe(0);
    expect(read(w, 'jobctr')).toBe('3');
    const polls = verbs(w).filter((c) => /get job \S+ -o json$/.test(c));
    expect(polls).toHaveLength(3);
  });

  it('Job active on one poll and Complete on the next, nothing observed between (TTL/poll case) -> 0', () => {
    const w = makeWorld(seq([ACTIVE, COMPLETE], [CLEAN_POD]));
    expect(launch(w).status).toBe(0);
  });

  it('events / Pending-pod noise while the Job is active is ignored: keep waiting, then Complete -> 0; events never read', () => {
    const pending = pod({}, { phase: 'Pending', reason: 'ProvisioningFailed', conditions: [{ type: 'PodScheduled', status: 'False', message: 'no topology key FailedAttachVolume' }] });
    const w = makeWorld(seq([ACTIVE, ACTIVE, ACTIVE, COMPLETE], [pending, CLEAN_POD]));
    expect(launch(w).status).toBe(0);
    // pods are only read once the Job is Complete
    expect(podReads(w)).toBe(1);
    expect(existsSync(join(w.logs, 'EVENTS-READ'))).toBe(false);
    expect(verbs(w).some((c) => c.includes('events'))).toBe(false);
  });

  it.each([
    ['DisruptionTarget=True', pod({}, { conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'DeletionByTaintManager' }] }), 'DisruptionTarget'],
    ['a deletionTimestamp', pod({ deletionTimestamp: '2026-10-19T00:00:00Z' }), 'deleted'],
    ['pod status.reason Terminated', pod({}, { reason: 'Terminated' }), 'Terminated'],
    ['pod status.reason NodeShutdown', pod({}, { reason: 'NodeShutdown' }), 'NodeShutdown'],
    ['pod status.reason Evicted', pod({}, { reason: 'Evicted' }), 'Evicted'],
    ['pod status.reason Preempting', pod({}, { reason: 'Preempting' }), 'Preempting'],
    ['pod status.reason Shutdown', pod({}, { reason: 'Shutdown' }), 'Shutdown'],
  ])('Complete but the pod has %s -> 71 (B-1187: a disruption), naming the evidence', (_l, p, needle) => {
    const w = makeWorld(seq([COMPLETE], [p]));
    const r = launch(w);
    expect(r.status).toBe(71);
    expect(r.stderr).toContain(needle);
  });

  it('ANY pod of the Job with disruption evidence fails the leg', () => {
    const two = { items: [pod().items[0], pod({}, { reason: 'Evicted' }).items[0]] };
    expect(launch(makeWorld(seq([COMPLETE], [two]))).status).toBe(71);
  });

  it('Complete with a normally finished container (containerStatuses terminated/Completed, no pod-level reason) -> 0', () => {
    const finished = pod({}, { containerStatuses: [{ name: 'worker', state: { terminated: { reason: 'Completed', exitCode: 0 } } }] });
    const w = makeWorld(seq([COMPLETE], [finished]));
    expect(launch(w).status).toBe(0);
  });

  it('pod list unreadable 3 times -> 1 with the cannot-confirm message', () => {
    for (const bad of ['ERR', 'GARBAGE']) {
      const w = makeWorld(seq([COMPLETE], [bad]));
      const r = launch(w);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not be confirmed');
      expect(podReads(w)).toBe(3);
    }
  });

  it('an empty pod list counts as unreadable -> 1', () => {
    const w = makeWorld(seq([COMPLETE], [{ items: [] }]));
    const r = launch(w);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not be confirmed');
  });

  it('pod list unreadable once then clean -> 0', () => {
    const w = makeWorld(seq([COMPLETE], ['ERR', CLEAN_POD]));
    expect(launch(w).status).toBe(0);
    expect(podReads(w)).toBe(2);
  });
});

const jobsJson = (items: Array<{ name: string; types: string[] }>) =>
  JSON.stringify({ items: items.map((i) => ({ metadata: { name: i.name }, status: { conditions: i.types.map((type) => ({ type, status: 'True' })) } })) });

describe.skipIf(!CAPABLE)('gke-worker-probe.sh', () => {
  it('exit 0 when an unsettled Job exists for the conduction', () => {
    const w = makeWorld({ STUB_JOBS_JSON: jobsJson([{ name: 'a', types: [] }]) });
    expect(run(w, PROBE, [CID, TICKET]).status).toBe(0);
    expect(calls(w)[0]).toEqual(['-n', 'harmony-legs', 'get', 'jobs', '-l', `conduction-id=${CID}`, '-o', 'json']);
  });

  it('exit 1 when every Job is Complete or Failed, or none exists', () => {
    expect(run(makeWorld({ STUB_JOBS_JSON: jobsJson([{ name: 'a', types: ['Complete'] }, { name: 'b', types: ['Failed'] }]) }), PROBE, [CID, TICKET]).status).toBe(1);
    expect(run(makeWorld({ STUB_JOBS_JSON: jobsJson([]) }), PROBE, [CID, TICKET]).status).toBe(1);
  });
});

describe.skipIf(!CAPABLE)('gke-worker-reap.sh', () => {
  it('deletes each unsettled Job with --cascade=background, exits 0, never deletes a PVC', () => {
    const w = makeWorld({ STUB_JOBS_JSON: jobsJson([{ name: 'a', types: [] }, { name: 'b', types: ['Complete'] }, { name: 'c', types: [] }]) });
    mkdirSync(join(w.home, '.harmony-conductions', TICKET, CID), { recursive: true });
    writeFileSync(join(w.home, '.harmony-conductions', TICKET, CID, 'run.env'), 'GIT_TOKEN=x\n');
    expect(run(w, REAP, [CID, TICKET]).status).toBe(0);
    const deletes = calls(w).filter((c) => c.includes('delete'));
    expect(deletes).toEqual([
      ['-n', 'harmony-legs', 'delete', 'job', 'a', '--cascade=background', '--wait=false'],
      ['-n', 'harmony-legs', 'delete', 'job', 'c', '--cascade=background', '--wait=false'],
    ]);
    expect(verbs(w).some((c) => /pvc|persistentvolumeclaim/i.test(c))).toBe(false);
    expect(minted(w)).toBe(false);
  });

  it('B-1187: a failed delete -> exit 1 (even when another Job was deleted), never 0', () => {
    const w = makeWorld({ STUB_DELETE_FAILS: '1', STUB_JOBS_JSON: jobsJson([{ name: 'a', types: [] }]) });
    const r = run(w, REAP, [CID, TICKET]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not delete job a');
  });

  it('exit 3 when nothing is unsettled, and nothing is deleted', () => {
    const w = makeWorld({ STUB_JOBS_JSON: jobsJson([{ name: 'b', types: ['Failed'] }]) });
    expect(run(w, REAP, [CID, TICKET]).status).toBe(3);
    expect(verbs(w).some((c) => c.includes('delete'))).toBe(false);
  });
});
