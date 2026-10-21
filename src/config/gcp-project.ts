// B-1186: ONE place that answers "which GCP project does this conductor use?". The lifecycle in-flight guard,
// the pre-flight reach check and `conductor logs` all call it, so none of them keeps its own fallback.
//
// There is deliberately NO default project: a hard-coded name here is a different team's project on every
// machine but one. With nothing configured the callers fail with GCP_PROJECT_UNSET, which says where to set it.
//
// Root cause this replaces (`conductor logs`, found while writing this): it called `loadConductorConfigSync`
// and swallowed the throw. That loader validates the WHOLE config (plugin_dir, github_app, ...), so a machine
// that has the project file but not a complete host file threw a ConductorConfigError for an unrelated key and
// the logs command read it as "no project" even though gcp.project was present, nested, in the file. Separately
// the loader finds the project file only through HARMONY_CONDUCTOR_PROJECT_FILE or the sync snapshot, never the
// `.harmony/conductor.json` in the directory the operator is standing in. `evaluateConductorConfig` collects
// issues instead of throwing, so the merged value is readable even when other keys are incomplete.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONDUCTOR_PROJECT_PATH,
  evaluateConductorConfig,
  validateProjectFileText,
  type ConductorConfig,
} from './conductor-config.js';
import { loadLegacyDeploymentConfig } from './deployment-config.js';

export const GCP_PROJECT_UNSET =
  'no GCP project is configured: set "gcp": { "project": "<gcp-project-id>" } in .harmony/conductor.json (or in ~/.harmony/conductor-host.json)';

export interface GcpProjectDeps {
  env: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  /** Directory whose `.harmony/conductor.json` is the last discovery step. Default: process.cwd(). */
  cwd?: string;
  /** A merged config the caller already evaluated; skips the evaluation. */
  merged?: ConductorConfig | null;
}

/** The configured GCP project, or undefined. Never throws.
 *  Order: an operator-exported CLOUDSDK_CORE_PROJECT, else gcp.project of the merged config (project + host +
 *  snapshot + legacy layers, nested exactly as the files carry it), else gcp.project of ./.harmony/conductor.json. */
export function resolveGcpProject(deps: GcpProjectDeps): string | undefined {
  const exported = deps.env.CLOUDSDK_CORE_PROJECT;
  if (exported) return exported;
  const exists = deps.existsSync ?? fsExistsSync;
  const read = deps.readFileSync ?? ((p: string) => fsReadFileSync(p, 'utf8'));

  let merged = deps.merged ?? null;
  if (!merged) {
    try {
      merged =
        evaluateConductorConfig({
          env: deps.env,
          existsSync: exists,
          readFileSync: read,
          warn: () => {},
          loadLegacy: () => loadLegacyDeploymentConfig({ env: deps.env, existsSync: exists, readFileSync: read }),
        })?.merged ?? null;
    } catch {
      merged = null; // a malformed legacy deployment.json is not a reason to lose the project file's value
    }
  }
  if (merged?.gcp?.project) return merged.gcp.project;

  try {
    const local = join(deps.cwd ?? process.cwd(), CONDUCTOR_PROJECT_PATH);
    if (exists(local)) {
      const v = validateProjectFileText(CONDUCTOR_PROJECT_PATH, read(local));
      if (v.ok) return v.value.gcp?.project;
    }
  } catch {
    /* unreadable: treated as absent */
  }
  return undefined;
}
