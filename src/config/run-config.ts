// B-846: the run-config plumbing seam.
//
// Ships the plumbing every future run-scoped operator choice (steering note, per-gate model,
// auto-approve gate list, session persistence, ...) will write into. This ticket itself adds ZERO
// operator-facing behavior — the schema below is deliberately a `{}` skeleton (no axis keys yet),
// and every launch profile mounts/forwards nothing but `{}` until a dependent ticket adds its own
// top-level key. See `conductions.run_config` (harmony-web migration: `jsonb NOT NULL DEFAULT
// '{}'::jsonb`) for the DB-side half this seam ultimately reads forward from.
//
// Delivery to the worker is TWO forms, because the two launch profiles have different
// capabilities (see scripts/mint-installation-token.mjs's own header for why):
//   - local docker profile: a mounted JSON FILE, path given by HARMONY_RUN_CONFIG_PATH.
//   - cloud (Cloud Run) profile: `gcloud run jobs execute` has no ad-hoc file-content volume
//     mount, so the content rides inline as base64-encoded JSON in HARMONY_RUN_CONFIG_JSON — the
//     same channel HARMONY_REPOS_JSON already proved (see serializeReposSection in the mint
//     script).
// The accessor below supports BOTH so it works unmodified regardless of which profile launched
// the worker. File-path wins when (implausibly) both are set.

import { readFileSync as nodeReadFileSync } from 'node:fs';
import { z } from 'zod';

/** B-718: resume-and-reconcile controlled-mode legs from the prior leg's persisted Claude
 *  session, when one is discoverable (see container/provision.sh's same-conduction discovery,
 *  container/entrypoint.sh's cloud-profile cross-conduction discovery, and
 *  scripts/resume-discovery.mjs's local-docker-profile cross-conduction discovery). DEFAULTS TO
 *  DISABLED — the design brief originally proposed default-true, but a later accept-with-remark
 *  overrode that: session-resume must stay OFF until the AC2 reshape-override smoke test actually
 *  demonstrates the current ticket decision wins over a stale resumed transcript. A human flips it
 *  on via a conduction row's `run_config.session_resume.enabled` once that case is proven — there
 *  is no code-level default-true fallback anywhere in this ticket's implementation. */
const SessionResumeSchema = z.object({ enabled: z.boolean() }).optional();

/** No other axis keys yet — each dependent ticket adds ONE top-level key here.
 *  `.passthrough()` so an accessor build that predates a newer key never throws on it — forward
 *  compatible by construction, same as this ticket's own additive-only design intent. */
export const RunConfigSchema = z.object({ session_resume: SessionResumeSchema }).passthrough();
export type RunConfig = z.infer<typeof RunConfigSchema>;
export const EMPTY_RUN_CONFIG: RunConfig = {};

/** B-718: is session-resume enabled for this run_config payload? Defaults to `false` — an absent
 *  `session_resume` key, an absent `enabled` sub-key, or `enabled: false` all read as disabled;
 *  only an EXPLICIT `session_resume.enabled: true` turns it on. Never throws — a malformed
 *  `session_resume` shape would already have been rejected by RunConfigSchema.parse at read time
 *  (see getRunConfig), so by the time a RunConfig value reaches this accessor it is trusted. */
export function isSessionResumeEnabled(runConfig: RunConfig): boolean {
  return runConfig.session_resume?.enabled === true;
}

/** B-694 empty-env-value shadow class, matching src/daemon/config.ts's own envValue convention: a
 *  var set to '' behaves exactly like unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v == null || v === '' ? undefined : v;
}

/** Reads the plain (deliberately NOT `HARMONY_`-prefixed) `HARMONY_CONDUCTION_ID` env var every
 *  launch profile now always sets alongside the minted credential env-file. Undefined when
 *  absent — this is a "was one set" query, never a hard requirement, so it never throws for
 *  absence.
 *
 *  NOT to be confused with container/entrypoint.sh's own bare `$CONDUCTION_ID` — that is a
 *  pre-existing, unrelated var feeding entrypoint.sh's cloud-only transcript-mount symlink logic
 *  (B-788). This ticket does not rename or touch that one. */
export function getConductionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, 'HARMONY_CONDUCTION_ID');
}

export interface GetRunConfigDeps {
  /** Injectable so this accessor is unit-testable without touching the real filesystem — mirrors
   *  scripts/mint-installation-token.mjs's resolveBaseContent readImpl injection style. */
  readFileSync?: (path: string) => string;
}

/** Resolve this worker's run_config payload.
 *
 *  Precedence: (a) HARMONY_RUN_CONFIG_PATH set -> read + JSON.parse that file; (b) else
 *  HARMONY_RUN_CONFIG_JSON set -> base64-decode then JSON.parse; (c) else EMPTY_RUN_CONFIG (`{}`).
 *
 *  Malformed JSON text from EITHER source throws (JSON.parse's own error, never swallowed). A
 *  parsed value that isn't a plain object (array, string, number, null) also throws, via
 *  RunConfigSchema.parse's own rejection — this accessor never silently coerces a malformed
 *  payload into the empty default. */
export function getRunConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: GetRunConfigDeps = {},
): RunConfig {
  const readFile = deps.readFileSync ?? ((p: string) => nodeReadFileSync(p, 'utf8'));

  const path = envValue(env, 'HARMONY_RUN_CONFIG_PATH');
  if (path) {
    return RunConfigSchema.parse(JSON.parse(readFile(path)));
  }

  const inline = envValue(env, 'HARMONY_RUN_CONFIG_JSON');
  if (inline) {
    const decoded = Buffer.from(inline, 'base64').toString('utf8');
    return RunConfigSchema.parse(JSON.parse(decoded));
  }

  return EMPTY_RUN_CONFIG;
}
