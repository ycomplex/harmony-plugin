// B-1166: small pure helpers for the daemon's boot/shutdown legibility — which process supervisor
// (if any) owns restart, and whether the boot-time local `docker inspect` applies to the profile.

/** The launchd service label of container/launchd/com.ycomplex.harmony-daemon.plist. */
export const LAUNCHD_SERVICE_NAME = 'com.ycomplex.harmony-daemon';

/** Which supervisor started this process, from its environment alone — or null when unsupervised. */
export function detectSupervisor(env: NodeJS.ProcessEnv): string | null {
  if (env.XPC_SERVICE_NAME === LAUNCHD_SERVICE_NAME) return 'launchd';
  if (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0) return 'systemd';
  return null;
}

/** The exact SIGTERM/SIGINT stop log line. */
export function shutdownLine(signal: string, supervisor: string | null): string {
  return supervisor === null
    ? `received ${signal} — exiting (unsupervised)`
    : `received ${signal} — exiting (${supervisor} owns restart)`;
}

export interface WorkerImageCheckProfile {
  launch?: string;
  required_tools?: { launch?: string[]; reap?: string[]; probe?: string[] };
}

/** True only when the profile uses local docker, i.e. the B-1074 `docker inspect` can mean anything.
 *  Decided from `required_tools` (any of launch/reap/probe naming `docker`). When `required_tools`
 *  is absent entirely (a pre-B-801 profile) we fall back to the launch template: inspect only if it
 *  contains the word `docker`; with neither signal we do NOT run docker (a missing binary is noise). */
export function shouldInspectWorkerImage(profile: WorkerImageCheckProfile): boolean {
  const rt = profile.required_tools;
  if (rt !== undefined) {
    return [rt.launch, rt.reap, rt.probe].some((tools) => Array.isArray(tools) && tools.includes('docker'));
  }
  return /\bdocker\b/.test(profile.launch ?? '');
}
