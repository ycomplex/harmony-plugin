// B-1171: the launching backend of a lease's leg (conductions.leg_backend).
//
// A conductor adopting a lease it did not launch must reap/probe a leg with the template of the
// backend that LAUNCHED it, not with its own profile's (a gke conductor running the cloud reap script
// against a gke pod is a silent no-op that leaves the pod running). So each launch records a stable
// backend tag, and an adoption resolves the recorded tag back to a profile of the deployment config.
//
// There is no `kind` field on a launch profile; the tag is derived from the wrapper script the launch
// template invokes (the one structural fact every shipped profile has), falling back to the profile's
// name. The column itself is tolerated absent — see src/tools/conduction-record.ts.

import type { LaunchProfile } from './config.js';

/** Derive the stable backend tag of a launch profile: 'gke' | 'cloud' | 'docker-host' | 'docker' by the
 *  shipped wrapper the launch template invokes, else the profile's name (else 'unnamed'). */
export function deriveBackendTag(profileName: string | undefined, profile: Pick<LaunchProfile, 'launch'>): string {
  const launch = profile.launch ?? '';
  if (launch.includes('gke-worker-launch')) return 'gke';
  if (launch.includes('docker-host-worker-launch')) return 'docker-host';
  if (launch.includes('cloud-worker-launch')) return 'cloud';
  if (launch.includes('docker-worker-launch')) return 'docker';
  return profileName && profileName.length > 0 ? profileName : 'unnamed';
}

/** The reap/probe pair of the profile that owns a backend tag. */
export type BackendTemplates = Pick<LaunchProfile, 'reap' | 'probe'>;

/** Resolve the profile (by backend tag) among a deployment config's profiles; null when none matches. */
export function resolveBackendTemplates(
  profiles: Record<string, LaunchProfile> | undefined | null,
  tag: string,
): BackendTemplates | null {
  for (const [name, p] of Object.entries(profiles ?? {})) {
    if (deriveBackendTag(name, p) === tag) return { reap: p.reap, probe: p.probe };
  }
  return null;
}
