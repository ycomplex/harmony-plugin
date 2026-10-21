// B-1173: the boot helper baked into the conductor image (dist/bin/conductor-boot.js). Two verbs, both credential-free
// at the CLI surface:
//
//   exec -- <command> [args...]   resolve the remote conductor's secrets (HARMONY_API_TOKEN, HARMONY_APP_PRIVATE_KEY)
//                                 from Secret Manager into the CHILD's environment, then run the command with stdio
//                                 inherited and exit with its code. This is how a pod's CronJob (the ticket-disk
//                                 sweep) gets the API token without an env file. The conductor Deployment itself does
//                                 not need it: the daemon resolves its own secrets at boot.
//   check-host <file>             validate a host file against the strict host schema and print its secret NAMES only.
//                                 The image smoke runs it on conductor.host.example.json. No network, no gcloud.
//
//   preflight [--host-file f] [--project-file f] [--plugin-dir d]
//                                 B-1186: the gke profile's BOOT PREFLIGHT (src/daemon/preflight.ts) with
//                                 HARMONY_CONDUCTOR_REMOTE=1, against the baked example host + project files, plus a
//                                 presence check of every plugin file the launch path reaches. No network, no cluster,
//                                 no credential. The image smoke runs it BEFORE anything is pushed, so an image that
//                                 lacks a tool the pod needs (or a scripts/ file) fails the build instead of
//                                 crash-looping in the cluster. Defaults are the files baked in the image.
//
// Everything with a side effect is injected, so the unit test needs no gcloud and no child process.

import { HostFileSchema, launchEnvFromMerged, loadConductorConfigSync } from '../config/conductor-config.js';
import { runBootPreflight, type PreflightProfile } from './preflight.js';
import type { DaemonConfig } from './config.js';
import { resolveConductorSecrets, type SecretExec } from '../config/conductor-secrets.js';

type Env = Record<string, string | undefined>;

export interface BootDeps {
  env: Env;
  exec: SecretExec;
  readFile(path: string): string;
  /** B-1186: does a file exist (the `preflight` verb's presence checks). */
  fileExists(path: string): boolean;
  /** Runs the command with `env`, stdio inherited; resolves to its exit code. */
  run(command: string, args: string[], env: Env): Promise<number>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE =
  'usage: conductor-boot exec -- <command> [args...] | conductor-boot check-host <host-file> | conductor-boot preflight [--host-file f] [--project-file f] [--plugin-dir d]';

const DEFAULT_PLUGIN_DIR = '/opt/harmony-plugin';

/** B-1186: plugin files (relative to the plugin dir) the gke launch path executes or sources. A pod built without
 *  one of them launches nothing (0.15.88 shipped without scripts/). conductor-image-files.test.ts pins that each
 *  exists in the repo, so this list cannot name a file that was renamed away. */
export const PREFLIGHT_PLUGIN_FILES = [
  'dist/bin/daemon.js',
  'dist/bin/harmony.js',
  'scripts/mint-installation-token.mjs',
  'container/gke/gke-worker-launch.sh',
  'container/gke/gke-worker-reap.sh',
  'container/gke/gke-worker-probe.sh',
  'container/gke/gke-common.sh',
  'container/gke/gke-render-leg.mjs',
  'container/gke/sweep-ticket-disks.sh',
] as const;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runPreflightVerb(args: string[], deps: BootDeps): Promise<number> {
  const pluginDir = flagValue(args, '--plugin-dir') ?? DEFAULT_PLUGIN_DIR;
  const hostFile = flagValue(args, '--host-file') ?? `${pluginDir}/container/conductor.host.example.json`;
  const projectFile = flagValue(args, '--project-file') ?? `${pluginDir}/container/conductor.project.example.json`;
  const fail = (m: string): number => {
    deps.err(`conductor-boot preflight: FAIL - ${m}`);
    return 1;
  };

  // The config exactly as the pod loads it: remote mode, the two files, nothing else (no legacy deployment.json, no
  // snapshot, a home that holds nothing).
  const env: Env = {
    ...deps.env,
    HARMONY_CONDUCTOR_REMOTE: '1',
    HARMONY_CONDUCTOR_HOST_FILE: hostFile,
    HARMONY_CONDUCTOR_PROJECT_FILE: projectFile,
    HARMONY_HOME: '/nonexistent-harmony-home',
    HARMONY_APP_PRIVATE_KEY: 'preflight-fixture-not-a-secret', // a pod resolves this at boot; the fixture just satisfies the contract
  };
  let loaded;
  try {
    loaded = loadConductorConfigSync({ env: env as NodeJS.ProcessEnv, existsSync: deps.fileExists, readFileSync: deps.readFile, warn: () => {} });
  } catch (e) {
    return fail(`the host + project files do not load: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!loaded) return fail(`no config found (host ${hostFile}, project ${projectFile})`);
  const profileName = loaded.merged.profile ?? 'gke';
  const profile = loaded.deploymentConfig.profiles?.[profileName];
  if (!profile) return fail(`the project file names no usable launch profile (${profileName})`);

  // What the daemon would have pushed into its env before running the preflight.
  const preflightEnv: Env = { ...launchEnvFromMerged(loaded.merged), ...env, HARMONY_PLUGIN_DIR: pluginDir };
  const lines: string[] = [];
  try {
    await runBootPreflight({} as DaemonConfig, profile as PreflightProfile, {
      runCommand: async (cmd) => ({ exitCode: await deps.run('sh', ['-c', cmd], preflightEnv) }),
      env: preflightEnv,
      deploymentConfig: loaded.deploymentConfig,
      profileName,
      log: (l) => lines.push(l),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const missing = PREFLIGHT_PLUGIN_FILES.filter((f) => !deps.fileExists(`${pluginDir}/${f}`));
  if (missing.length > 0) return fail(`plugin files the launch path needs are missing under ${pluginDir}: ${missing.join(', ')}`);
  for (const l of lines) deps.out(`conductor-boot preflight: ${l}`);
  deps.out(`conductor-boot preflight: ok - profile ${profileName}, remote mode, ${PREFLIGHT_PLUGIN_FILES.length} plugin files present`);
  return 0;
}

export async function runConductorBoot(argv: string[], deps: BootDeps): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'check-host') {
    const path = rest[0];
    if (!path) {
      deps.err(USAGE);
      return 2;
    }
    let json: unknown;
    try {
      json = JSON.parse(deps.readFile(path));
    } catch {
      deps.err(`conductor-boot: ${path} could not be read as JSON`);
      return 1;
    }
    const parsed = HostFileSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      deps.err(`conductor-boot: ${path} is not a valid host file: ${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown problem'}`);
      return 1;
    }
    const names = Object.entries(parsed.data.secrets ?? {}).map(([k, v]) => `${k}=${v}`);
    deps.out(`host file ok: secrets (names only) ${names.length > 0 ? names.join(', ') : 'none'}`);
    return 0;
  }
  if (verb === 'preflight') return runPreflightVerb(rest, deps);
  if (verb === 'exec') {
    const cmd = rest[0] === '--' ? rest.slice(1) : rest;
    if (cmd.length === 0) {
      deps.err(USAGE);
      return 2;
    }
    const childEnv: Env = { ...deps.env };
    try {
      const r = await resolveConductorSecrets({ env: deps.env, target: childEnv, exec: deps.exec, readFile: deps.readFile });
      if (r.resolved.length > 0) deps.out(`conductor-boot: resolved ${r.resolved.join(', ')} from Secret Manager (values not shown)`);
    } catch (e) {
      deps.err(`conductor-boot: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    return deps.run(cmd[0] as string, cmd.slice(1), childEnv);
  }
  deps.err(USAGE);
  return 2;
}
