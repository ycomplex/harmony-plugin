// B-1170 (round B): the daemon's side of conductor config — everything src/bin/daemon.ts needs from
// the two-file model, kept OUT of that entrypoint (another ticket edits the same file, so the entrypoint
// gets "a loader call and a timer" and this module carries the logic).
//
// WHAT IT DOES
//   start   resolve the host file + config repo; when both a repo and a GitHub credential exist, refresh
//           the project-file snapshot ONCE (never throws — a failed refresh only logs and the last-good
//           snapshot stands); then load the merged config. When NO new-file input exists
//           (loadConductorConfigSync -> null) the daemon is on legacy files only: return an inert
//           runtime, start NO timer, touch NO env — it boots exactly as it did before B-1170.
//   launch  the launch scripts read HARMONY_GKE_* / HARMONY_CLOUD_RUN_* / CLOUDSDK_* from their process
//           env. The merged config's values are written into THIS process's env (applyLaunchEnv) so
//           children inherit them; an operator's explicit env always wins.
//   timer   every `intervalMs` (default 5 min, `.unref()`ed so it never keeps the process alive):
//           refresh the snapshot, reload, and if the merged config changed APPLY the hot keys at once
//           (concurrency.max_workers, model_policy, log_shipping, launch env) and only LOG the
//           restart-only ones. An invalid reload keeps the previous good config active and is logged
//           once per distinct message; the timer never throws and never stops the daemon.
//
// MODEL POLICY. The runtime only HOLDS the current policy (`getModelPolicy`). It is applied by the
// scheduler, by filling ABSENT keys into the run_config handed to the worker — see
// src/daemon/scheduler.ts `applyModelPolicy` for why that is the only consistent place.
//
// Every side effect is injected (env, log, fetch, clock, timers, fs), so the whole module is testable
// offline and a test never touches the real ~/.harmony or the network.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import {
  applyLaunchEnv,
  ConductorConfigError,
  diffRestartRequired,
  HostFileSchema,
  launchEnvFromMerged,
  loadConductorConfigSync,
  parseJsonText,
  resolveConductorPaths,
  resolveConfigRepo,
  type ConductorConfig,
  type ConductorLoadResult,
  type HostFile,
} from '../config/conductor-config.js';
import { refreshProjectFile } from '../config/conductor-project-source.js';
import { createGithubTokenProvider } from '../config/github-app-token.js';
import type { DeploymentConfig } from '../config/deployment-config.js';

export interface ModelPolicy {
  default?: string;
  per_gate?: Record<string, string>;
}

export const DEFAULT_CONDUCTOR_REFRESH_MS = 5 * 60_000;

type TimerHandle = { unref?: () => unknown } | number | undefined;

export interface ConductorConfigRuntimeDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** The daemon's MUTABLE DaemonConfig — the scheduler reads `maxConcurrentWorkers` from it each tick,
   *  so assigning it is how a hot change reaches the running loop. */
  config: { maxConcurrentWorkers: number };
  /** The legacy deployment.json loader (injected so this module has no import of the legacy loader). */
  loadLegacy: () => DeploymentConfig | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => TimerHandle;
  clearIntervalImpl?: (handle: TimerHandle) => void;
  readFileSync?: (path: string) => string;
  existsSync?: (path: string) => boolean;
  intervalMs?: number;
}

export interface ConductorConfigRuntime {
  /** Stop the refresh timer (idempotent). In-flight work is abandoned: nothing applies after stop(). */
  stop(): void;
  /** The merged config as a DeploymentConfig, or null when no new-file input exists (legacy-only host). */
  deploymentConfig: DeploymentConfig | null;
  /** The merged config's profile name — the daemon uses it only when `--profile` was not given. */
  defaultProfile: string | undefined;
  /** Run one refresh + reload cycle now (what the timer does). Never rejects. */
  applyNow(): Promise<void>;
  /** The current model policy, or undefined when the config sets none. */
  getModelPolicy(): ModelPolicy | undefined;
  /** The current log_shipping value (undefined = unset). Recorded here for the log-shipping consumer. */
  getLogShipping(): boolean | undefined;
  /** B-1174: the current merged gcp.project (undefined = unset). The log shipper reads this live. */
  getGcpProject(): string | undefined;
  /** B-1174: the current merged gcloud.account (undefined = unset). */
  getGcloudAccount(): string | undefined;
}

function inertRuntime(): ConductorConfigRuntime {
  return {
    stop() {},
    deploymentConfig: null,
    defaultProfile: undefined,
    async applyNow() {},
    getModelPolicy: () => undefined,
    getLogShipping: () => undefined,
    getGcpProject: () => undefined,
    getGcloudAccount: () => undefined,
  };
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function policyOf(merged: ConductorConfig): ModelPolicy | undefined {
  const p = merged.model_policy;
  if (!p || (p.default === undefined && !p.per_gate)) return undefined;
  return { ...(p.default !== undefined ? { default: p.default } : {}), ...(p.per_gate ? { per_gate: { ...p.per_gate } } : {}) };
}

export async function startConductorConfigRuntime(deps: ConductorConfigRuntimeDeps): Promise<ConductorConfigRuntime> {
  const { env, log } = deps;
  const exists = deps.existsSync ?? fsExistsSync;
  const read = deps.readFileSync ?? ((p: string) => fsReadFileSync(p, 'utf8'));
  const intervalMs = deps.intervalMs ?? DEFAULT_CONDUCTOR_REFRESH_MS;
  const paths = resolveConductorPaths(env);
  // Keys WE exported into env: not operator-supplied legacy knobs when the config is re-read.
  const applied = new Set<string>();

  /** The host file, only as far as the refresh needs it (repo + App identity). A malformed host file is
   *  NOT an error here — loadConductorConfigSync reports it with every other issue. */
  const readHost = (): HostFile | null => {
    if (!exists(paths.hostFile)) return null;
    try {
      const parsed = parseJsonText('conductor-host.json', read(paths.hostFile));
      if (!parsed.ok) return null;
      const r = HostFileSchema.safeParse(parsed.value);
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  };

  /** Refresh the snapshot. Never throws; a ConductorConfigError from repo resolution is the caller's
   *  to decide (at start it propagates, on a tick it is logged). */
  const refresh = async (): Promise<void> => {
    // An explicit HARMONY_CONDUCTOR_PROJECT_FILE (test override) is read instead of the snapshot, so a
    // network refresh would be wasted work and would write a snapshot nobody reads.
    if (paths.projectFile) return;
    const host = readHost();
    const target = resolveConfigRepo({ hostFile: host, env });
    if (!target) return;
    const tokenProvider = createGithubTokenProvider({ env, fetchImpl: deps.fetchImpl, now: deps.now, appOverride: host?.github_app });
    if (!tokenProvider) {
      log('conductor config: no GitHub credential, so the project file cannot be refreshed; using the last-good snapshot');
      return;
    }
    const r = await refreshProjectFile({
      repo: target.repo,
      ref: target.ref,
      snapshotPath: paths.snapshotFile,
      tokenProvider,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      warn: (m) => log(`conductor config: ${m}`),
    });
    if (r.outcome === 'updated') log(`conductor config: project file updated from ${target.repo}@${target.ref}`);
  };

  const load = (): ConductorLoadResult | null =>
    loadConductorConfigSync({
      env,
      existsSync: exists,
      readFileSync: read,
      warn: (m) => log(`conductor config: warning: ${m}`),
      loadLegacy: deps.loadLegacy,
      appliedEnvKeys: applied,
    });

  // ---- start: one best-effort refresh, then the first load (errors here propagate to the caller)
  try {
    await refresh();
  } catch (err) {
    if (err instanceof ConductorConfigError) throw err; // e.g. a malformed config_repo: the operator must fix it
    log(`conductor config: refresh failed unexpectedly: ${errMessage(err)}`);
  }
  const first = load();
  if (!first) return inertRuntime();

  let current = first;
  // Restart-only keys are diffed against what the daemon BOOTED with, not the previous tick: the running
  // process never changes them, so a still-pending restart stays pending (and is logged once per change).
  const booted = first.merged;
  let lastRestartLine = '';
  let modelPolicy = policyOf(first.merged);
  let logShipping = first.merged.log_shipping;
  let gcpProject = first.merged.gcp?.project;
  let gcloudAccount = first.merged.gcloud?.account;

  const pushLaunchEnv = (merged: ConductorConfig): string[] => applyLaunchEnv(env, launchEnvFromMerged(merged), applied);
  pushLaunchEnv(first.merged);
  log(`conductor config: sources=[${first.sources.join('; ')}]`);

  const lastInvalid = new Set<string>();
  let stopped = false;
  let inflight: Promise<void> | null = null;

  const cycle = async (): Promise<void> => {
    try {
      try {
        await refresh();
      } catch (err) {
        log(`conductor config: refresh failed: ${errMessage(err)}`);
      }
      let next: ConductorLoadResult | null;
      try {
        next = load();
      } catch (err) {
        // Keep the previous good config; say why ONCE per distinct message (a bad commit would otherwise
        // be re-logged every five minutes).
        const msg = errMessage(err);
        if (!lastInvalid.has(msg)) {
          lastInvalid.add(msg);
          log(`conductor config: reload failed, keeping the previous configuration:\n${msg}`);
        }
        return;
      }
      if (stopped || !next) return;
      lastInvalid.clear();
      if (JSON.stringify(next.merged) === JSON.stringify(current.merged)) return;

      const restart = diffRestartRequired(booted, next.merged);
      const restartLine = restart.join(', ');
      if (restartLine !== lastRestartLine) {
        lastRestartLine = restartLine;
        if (restart.length) log(`conductor config: restart needed — ${restartLine}`);
      }

      // ---- hot keys
      if (!env.HARMONY_DAEMON_MAX_CONCURRENT_WORKERS) {
        const profile = next.merged.profile;
        const wanted = profile ? next.deploymentConfig.profiles?.[profile]?.maxConcurrentWorkers : undefined;
        if (wanted !== undefined && wanted !== deps.config.maxConcurrentWorkers) {
          log(`conductor config: concurrency.max_workers ${deps.config.maxConcurrentWorkers} -> ${wanted} (applied)`);
          deps.config.maxConcurrentWorkers = wanted;
        }
      }
      const nextPolicy = policyOf(next.merged);
      if (JSON.stringify(nextPolicy) !== JSON.stringify(modelPolicy)) {
        modelPolicy = nextPolicy;
        log(`conductor config: model_policy ${nextPolicy ? JSON.stringify(nextPolicy) : 'cleared'} (applied)`);
      }
      if (next.merged.log_shipping !== logShipping) {
        logShipping = next.merged.log_shipping;
        // Log-only for now: the log-shipping consumer reads getLogShipping().
        log(`conductor config: log_shipping ${logShipping === undefined ? 'unset' : String(logShipping)} (recorded)`);
      }
      gcpProject = next.merged.gcp?.project;
      gcloudAccount = next.merged.gcloud?.account;
      const changed = pushLaunchEnv(next.merged);
      if (changed.length) log(`conductor config: launch env updated: ${changed.join(', ')}`);

      current = next;
    } catch (err) {
      log(`conductor config: refresh cycle failed: ${errMessage(err)}`);
    }
  };

  /** One cycle at a time: a tick that fires while one is still running (a slow GitHub) joins it. */
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inflight ??= cycle().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const setTimer = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearIntervalImpl ?? ((h) => clearInterval(h as Parameters<typeof clearInterval>[0]));
  const handle = setTimer(() => void tick(), intervalMs);
  if (typeof handle === 'object' && handle !== null) handle.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(handle);
    },
    deploymentConfig: first.deploymentConfig,
    defaultProfile: first.merged.profile,
    applyNow: tick,
    getModelPolicy: () => modelPolicy,
    getLogShipping: () => logShipping,
    getGcpProject: () => gcpProject,
    getGcloudAccount: () => gcloudAccount,
  };
}
