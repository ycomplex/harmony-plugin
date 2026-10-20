// B-1173: the conductor as a Kubernetes Deployment — the lifecycle verbs that act on it.
//
//   runKubeRestart   the REMOTE branch of `harmony conductor restart --request <id>`, run by the restarter the
//                    claiming pod spawns (HARMONY_CONDUCTOR_REMOTE=1). It must NOT git-pull or signal anything:
//                    it patches the Deployment `harmony-conductor` in namespace `harmony-conductor` through the
//                    pod's own service account (no --context) and lets Kubernetes do the rolling update.
//                      update   resolve the channel tag's NEWEST plugin version tag in Artifact Registry and
//                               `kubectl set image` to `<image>:<version>` — a pinned tag, NEVER the moving one
//                      restart  keep the current image, `kubectl rollout restart`
//                    then `kubectl rollout status --timeout=300s`. On success it does nothing more: Kubernetes
//                    stops the old pod (which releases the registry row cleanly) and the NEW pod completes the
//                    carried-over request (src/daemon/conductor-remote.ts). On a missed deadline it
//                    `kubectl rollout undo`s and completes the request FAILED with the reason; this process then
//                    exits non-zero, which is what resumes launching in the (still alive) old conductor.
//   runStartRemote / runStopRemote
//                    `harmony conductor start|stop --remote`, from an operator's machine with the CALLER's own
//                    kubectl credentials (--context from HARMONY_GKE_CONTEXT, which the config files derive from
//                    the gke cluster): scale the Deployment to 1 / 0. Stopping leaves running legs alone.
//
// Every side effect goes through LifecycleDeps (exec, clock, registry), so all of it is tested against fakes.

import { EXIT, Out } from './conductor-out.js';
import { ageText, completeRequest, openRegistry, pluginVersion, REGISTRY_ABSENT } from './conductor-registry-cli.js';
import type { CliResult } from './conductor-config.js';
import type { LifecycleDeps } from './conductor-lifecycle-deps.js';
import { loadSettings } from './conductor-preflight.js';
import { channelFromPosture } from '../../daemon/conductor-remote.js';
import type { RegistryStatus } from '../../daemon/conductor-registry.js';

export const KUBE_NAMESPACE = 'harmony-conductor';
export const KUBE_DEPLOYMENT = 'harmony-conductor';
/** The conductor container in the pod spec (HARMONY_CONDUCTOR_CONTAINER overrides). */
export const KUBE_CONTAINER = 'conductor';
export const ROLLOUT_TIMEOUT = '300s';
export const REMOTE_START_BUDGET_MS = 180_000;
export const REMOTE_START_POLL_MS = 5_000;
export const REMOTE_STOP_BUDGET_MS = 60_000;

type Env = Record<string, string | undefined>;

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

/** A release tag: 1.2.3 or v1.2.3 (no pre-release / sha / moving tags). */
const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function compareVersionTags(a: string, b: string): number {
  const pa = VERSION_TAG.exec(a);
  const pb = VERSION_TAG.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** From `gcloud artifacts docker tags list <image> --format=json`: the newest plugin version tag that points at the
 *  same image as the channel tag. Throws with the reason when there is none (never falls back to a moving tag). */
export function newestVersionTag(listJson: string, channel: string): string {
  let list: unknown;
  try {
    list = JSON.parse(listJson);
  } catch {
    throw new Error('the Artifact Registry tag listing was not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('the Artifact Registry tag listing was not a list');
  const last = (v: unknown): string => String(v ?? '').split('/').pop() ?? '';
  const entries = list.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { tag: last(o.tag ?? o.name), digest: last(o.version ?? o.digest) };
  });
  const channelEntry = entries.find((e) => e.tag === channel);
  if (!channelEntry) throw new Error(`the channel tag "${channel}" does not exist on the conductor image`);
  if (!channelEntry.digest) throw new Error(`the channel tag "${channel}" has no image digest in the listing`);
  const versions = entries.filter((e) => e.digest === channelEntry.digest && VERSION_TAG.test(e.tag)).map((e) => e.tag);
  if (versions.length === 0) {
    throw new Error(`the image behind the channel tag "${channel}" carries no plugin version tag; refusing to deploy a moving tag`);
  }
  return versions.sort(compareVersionTags).at(-1) as string;
}

interface KubeTarget {
  context?: string;
  env?: Env;
}

/** kubectl against the conductor Deployment's namespace. In-cluster (no context) unless `t.context` is given. */
function kubectl(deps: LifecycleDeps, t: KubeTarget, verb: string[], extra: string[] = []) {
  return deps.exec('kubectl', [...verb, ...extra, '-n', KUBE_NAMESPACE, ...(t.context ? ['--context', t.context] : [])], { env: t.env });
}

const deployment = `deployment/${KUBE_DEPLOYMENT}`;

// ---------------------------------------------------------------------------------------------------
// restart --request, in the cluster
// ---------------------------------------------------------------------------------------------------

export interface KubeRestartOptions {
  noPull?: boolean;
  dryRun?: boolean;
  request?: string;
}

export async function runKubeRestart(deps: LifecycleDeps, opts: KubeRestartOptions, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const requestId = opts.request as string;
  const action = opts.noPull ? 'restart' : 'update';
  const target: KubeTarget = { env: deps.env };
  const container = deps.env.HARMONY_CONDUCTOR_CONTAINER || KUBE_CONTAINER;
  const versionBefore = pluginVersion(deps, deps.env.HARMONY_PLUGIN_DIR || deps.cliPluginDir);
  const base = { remote_kube: true, action, plugin_version_before: versionBefore };

  /** A failure BEFORE the Deployment was touched: the request is failed, the old pod stays as it is. */
  const fail = async (reason: string, data: Record<string, unknown> = {}): Promise<CliResult> => {
    out.err(reason);
    const { line, note } = await completeRequest(deps, undefined, requestId, 'failed', reason, { ...base, ...data });
    out.line(line);
    return out.result(EXIT.failure, { ...base, ...data, error: reason, request: { id: requestId, result: 'failed', completion: note } });
  };

  out.line(`Remote conductor: ${action} request ${requestId} — patching deployment ${KUBE_DEPLOYMENT} in namespace ${KUBE_NAMESPACE} (no git pull, no local restart).`);

  // 1. The current image (also proves kubectl and the service account work before anything changes).
  const got = await kubectl(deps, target, ['get', deployment], ['-o', 'json']);
  if (got.code === 127) return fail('kubectl is not installed in this container; the Deployment was not changed');
  if (got.code !== 0) return fail(`could not read the Deployment: ${firstLine(got.stderr || got.stdout)}. The running conductor was left untouched.`);
  let currentImage: string | undefined;
  try {
    const containers = (JSON.parse(got.stdout) as { spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } } }).spec?.template?.spec?.containers ?? [];
    currentImage = (containers.find((c) => c.name === container) ?? (containers.length === 1 ? containers[0] : undefined))?.image;
  } catch {
    // handled below
  }
  if (!currentImage) return fail(`the Deployment has no container named "${container}" (set HARMONY_CONDUCTOR_CONTAINER); it was not changed`);
  out.line(`  current image: ${currentImage}`);

  // 2. What to roll out to.
  let newImage: string | null = null;
  let versionAfter = versionBefore;
  if (action === 'update') {
    const image = deps.env.HARMONY_CONDUCTOR_IMAGE;
    const channel = channelFromPosture(deps.env.HARMONY_PLUGIN_POSTURE);
    if (!image) return fail('HARMONY_CONDUCTOR_IMAGE is not set (the Artifact Registry path of the conductor image); the Deployment was not changed');
    if (!channel) return fail(`cannot tell the update channel: HARMONY_PLUGIN_POSTURE is ${deps.env.HARMONY_PLUGIN_POSTURE ? `"${deps.env.HARMONY_PLUGIN_POSTURE}"` : 'not set'}; the Deployment was not changed`);
    const tags = await deps.exec('gcloud', ['artifacts', 'docker', 'tags', 'list', image, '--format=json'], { env: deps.env });
    if (tags.code !== 0) return fail(`could not list the image tags of ${image}: ${tags.code === 127 ? 'gcloud is not installed' : firstLine(tags.stderr || tags.stdout)}. The Deployment was not changed.`);
    let version: string;
    try {
      version = newestVersionTag(tags.stdout, channel);
    } catch (err) {
      return fail(`${err instanceof Error ? err.message : String(err)}. The Deployment was not changed.`);
    }
    newImage = `${image}:${version}`;
    versionAfter = version.replace(/^v/, '');
    out.line(`  channel ${channel}: newest plugin version ${version} -> ${newImage}`);
  }
  const data = { ...base, plugin_version_after: versionAfter, image: newImage ?? currentImage };

  if (opts.dryRun) {
    out.line('Dry run: nothing changed. A real run would:');
    out.line(newImage ? `  - kubectl set image ${deployment} ${container}=${newImage} -n ${KUBE_NAMESPACE}` : `  - kubectl rollout restart ${deployment} -n ${KUBE_NAMESPACE}`);
    out.line(`  - kubectl rollout status ${deployment} -n ${KUBE_NAMESPACE} --timeout=${ROLLOUT_TIMEOUT}`);
    return out.result(EXIT.ok, { ...data, dry_run: true });
  }

  // 3. Already there: nothing to roll out, so nobody else will complete the request — this process does.
  if (newImage && newImage === currentImage) {
    out.line(`  the Deployment already runs ${newImage}; nothing to roll out.`);
    const reason = `update: already at the channel's latest (plugin ${versionAfter}); nothing to roll out`;
    const { line, note } = await completeRequest(deps, undefined, requestId, 'done', reason, data);
    out.line(line);
    return out.result(EXIT.ok, { ...data, restarted: false, request: { id: requestId, result: 'done', completion: note } });
  }

  // 4. Patch.
  const patch = newImage
    ? await kubectl(deps, target, ['set', 'image', deployment, `${container}=${newImage}`])
    : await kubectl(deps, target, ['rollout', 'restart', deployment]);
  if (patch.code !== 0) return fail(`${newImage ? 'kubectl set image' : 'kubectl rollout restart'} failed: ${firstLine(patch.stderr || patch.stdout)}. The running conductor was left untouched.`, data);
  out.line(newImage ? `  set image ${container}=${newImage}` : '  rollout restart issued');

  // 5. Wait. Kubernetes surges a new pod (standby until the old one releases), then stops the old one.
  out.line(`  waiting for the rollout (up to ${ROLLOUT_TIMEOUT})`);
  const status = await kubectl(deps, target, ['rollout', 'status', deployment], [`--timeout=${ROLLOUT_TIMEOUT}`]);
  if (status.code === 0) {
    out.line('Rollout complete. The new pod completes the request once it holds the registry row.');
    return out.result(EXIT.ok, { ...data, restarted: true, request: { id: requestId, result: 'pending-new-pod' } });
  }

  // 6. Missed the deadline (or the rollout failed): roll back and fail the request, visibly.
  out.line(`  rollout did not finish: ${firstLine(status.stderr || status.stdout)}`);
  const undo = await kubectl(deps, target, ['rollout', 'undo', deployment]);
  let rollback: string;
  if (undo.code !== 0) rollback = `rollback FAILED (${firstLine(undo.stderr || undo.stdout)}) — check the Deployment by hand`;
  else {
    const settled = await kubectl(deps, target, ['rollout', 'status', deployment], [`--timeout=${ROLLOUT_TIMEOUT}`]);
    rollback = settled.code === 0 ? 'rolled back to the previous revision' : 'rollback issued but has not settled yet';
  }
  out.line(`  ${rollback}`);
  const reason = `${action} did not complete: the rollout missed its ${ROLLOUT_TIMEOUT} progress deadline (${firstLine(status.stderr || status.stdout) || `kubectl exit ${status.code}`}); ${rollback}`;
  out.err(reason);
  const { line, note } = await completeRequest(deps, undefined, requestId, 'failed', reason, data);
  out.line(line);
  return out.result(EXIT.failure, { ...data, restarted: false, rolled_back: undo.code === 0, error: reason, request: { id: requestId, result: 'failed', completion: note } });
}

// ---------------------------------------------------------------------------------------------------
// start --remote / stop --remote, from an operator's machine
// ---------------------------------------------------------------------------------------------------

export interface RemoteVerbOptions {
  config?: string;
}

const KUBECTL_MISSING = 'kubectl is not installed on this machine';

async function scale(deps: LifecycleDeps, t: KubeTarget, replicas: number) {
  return kubectl(deps, t, ['scale', deployment], [`--replicas=${replicas}`]);
}

const timing = (env: Env) => {
  const n = (k: string, d: number): number => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return { budgetMs: n('HARMONY_SWITCH_TIMEOUT_S', REMOTE_START_BUDGET_MS / 1000) * 1000, pollMs: n('HARMONY_SWITCH_POLL_S', REMOTE_START_POLL_MS / 1000) * 1000, stopMs: n('HARMONY_SWITCH_STOP_TIMEOUT_S', REMOTE_STOP_BUDGET_MS / 1000) * 1000 };
};

const where = (context: string | undefined): string => (context ? `context ${context}` : 'the current kubectl context');

export async function runStartRemote(deps: LifecycleDeps, opts: RemoteVerbOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const s = await loadSettings(deps, { config: opts.config });
  const target: KubeTarget = { context: s.env.HARMONY_GKE_CONTEXT || undefined, env: s.env };
  const t = timing(s.env);

  const h = await openRegistry(deps, s);
  if ('error' in h) {
    out.err(`start --remote needs the registry to confirm the conductor: ${h.error}. Nothing was started.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, remote: true });
  }
  const before = await h.client.status();
  if (before.kind === 'unavailable') {
    out.err(`start --remote needs the conductor registry, and ${REGISTRY_ABSENT}. Nothing was started.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, remote: true, registry: 'unavailable' });
  }
  if (before.kind === 'status' && before.status.state === 'running' && before.status.location !== 'remote') {
    out.err(`a conductor is already running for this project (location ${before.status.location ?? 'unknown'}${before.status.host ? `, host ${before.status.host}` : ''}); a remote conductor would only stand by. Stop it first (\`harmony conductor stop\`). Nothing was started.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, remote: true, location: before.status.location });
  }

  out.line(`Scaling deployment ${KUBE_DEPLOYMENT} in namespace ${KUBE_NAMESPACE} to 1 replica (${where(target.context)}).`);
  const r = await scale(deps, target, 1);
  if (r.code !== 0) {
    out.err(`${r.code === 127 ? KUBECTL_MISSING : `kubectl scale failed: ${firstLine(r.stderr || r.stdout)}`}. Nothing was started.${r.code === 127 ? '' : ' If the Deployment does not exist yet, apply its manifest first.'}`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, remote: true });
  }

  out.line(`Waiting up to ${t.budgetMs / 1000}s for the conductor to register from the cluster.`);
  const deadline = deps.now() + t.budgetMs;
  let last: string;
  for (;;) {
    const st = await h.client.status();
    if (st.kind === 'status') {
      const reg: RegistryStatus = st.status;
      last = `registry ${reg.state}, location ${reg.location ?? 'unknown'}`;
      if (reg.state === 'running' && reg.location === 'remote') {
        out.line('');
        out.line(`Conductor started in the cluster: ${reg.host ?? 'pod'}, plugin ${reg.plugin_version ?? 'unknown'}, heartbeat ${ageText(reg.heartbeat_age_seconds)}.`);
        return out.result(EXIT.ok, { started: true, remote: true, host: reg.host, plugin_version: reg.plugin_version, holder_id: reg.holder_id });
      }
    } else last = `status read failed (${st.detail})`;
    if (deps.now() >= deadline) break;
    await deps.sleep(t.pollMs);
  }
  out.err(`the remote conductor was NOT confirmed within ${t.budgetMs / 1000}s (${last}). The Deployment is scaled to 1; see \`kubectl -n ${KUBE_NAMESPACE} get pods\` and \`harmony conductor logs --source cloud\`.`);
  return out.result(EXIT.notAdopted, { error: out.errLines[0], started: false, remote: true });
}

export async function runStopRemote(deps: LifecycleDeps, opts: RemoteVerbOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const s = await loadSettings(deps, { config: opts.config });
  const target: KubeTarget = { context: s.env.HARMONY_GKE_CONTEXT || undefined, env: s.env };
  const t = timing(s.env);

  out.line(`Scaling deployment ${KUBE_DEPLOYMENT} in namespace ${KUBE_NAMESPACE} to 0 replicas (${where(target.context)}).`);
  const r = await scale(deps, target, 0);
  if (r.code !== 0) {
    out.err(r.code === 127 ? `${KUBECTL_MISSING}. Nothing was stopped.` : `kubectl scale failed: ${firstLine(r.stderr || r.stdout)}. Nothing was stopped.`);
    return out.result(EXIT.failure, { error: out.errLines[0], stopped: false, remote: true });
  }
  out.line('Running legs keep running as their own jobs; the next start adopts them.');

  // Best effort: the pod releases its registry row on SIGTERM; say when that has happened.
  const h = await openRegistry(deps, s);
  let released: boolean | null = null;
  if (!('error' in h)) {
    const deadline = deps.now() + t.stopMs;
    for (;;) {
      const st = await h.client.status();
      if (st.kind !== 'status') break;
      released = !(st.status.state === 'running' && st.status.location === 'remote');
      if (released || deps.now() >= deadline) break;
      await deps.sleep(Math.min(t.pollMs, 2_000));
    }
  }
  out.line(released === true ? 'Conductor stopped: the registry row is released.' : released === false ? `The pod was told to stop, but the registry still shows it within ${t.stopMs / 1000}s; it releases the row as it terminates (\`harmony conductor status\`).` : 'Conductor scaled to 0.');
  return out.result(EXIT.ok, { stopped: true, remote: true, registry_released: released });
}
