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
import type { Gate } from '../daemon/gate-phase.js';

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

/** B-743: the free-text operator note — a per-run steering instruction the human types into the
 *  Conduct dialog's "Run options" surface (web-side; the plugin-side half this ticket ships).
 *  Unblocked by the SAME ticket that moves {run_config_json}'s base64 encoding upstream into
 *  scheduler.ts (see runConfigJsonFor's own header) — v1's boolean/object-only restriction existed
 *  ONLY to keep a raw single quote from ever reaching the single-quoted shell template literal, and
 *  that restriction is now obsolete: the shell only ever sees base64. Optional, plain string —
 *  `''`/absent both read as "no note" via getOperatorNote below. */
const NoteSchema = z.string().optional();

/** B-772: the per-run model-selection axis — the human's Conduct-dialog choice of which Claude
 *  model each gate's leg runs on. `default` is a run-wide fallback (every gate that has no
 *  `per_gate` entry of its own uses it); `per_gate` overrides ONE named gate (keyed by the `Gate`
 *  values src/daemon/gate-phase.ts's `resolveGatePhase` produces — 'clarify'/'decompose'/'design'/
 *  'plan'/'build'/'release'/'verify'). Both optional, independently: a payload may set only
 *  `default`, only `per_gate`, both, or neither (the all-pinned-defaults case — see
 *  getModelForGate's three-level fallback below). Deliberately a bare `Record<string, string>` for
 *  `per_gate` (not a `Partial<Record<Gate, string>>`) — an operator-authored/web-authored payload
 *  naming a gate key this build's Gate enum doesn't (yet) recognize must still PARSE (forward
 *  compat, same reasoning as this schema's own `.passthrough()`); getModelForGate only ever LOOKS
 *  UP a real `Gate` value, so an unrecognized key is simply never read, never a parse-time reject. */
const ModelSchema = z
  .object({
    default: z.string().optional(),
    per_gate: z.record(z.string()).optional(),
  })
  .optional();

/** No other axis keys yet — each dependent ticket adds ONE top-level key here.
 *  `.passthrough()` so an accessor build that predates a newer key never throws on it — forward
 *  compatible by construction, same as this ticket's own additive-only design intent. */
export const RunConfigSchema = z
  .object({ session_resume: SessionResumeSchema, note: NoteSchema, model: ModelSchema })
  .passthrough();
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

/** B-743: the operator note for this run_config payload, or `undefined` when none was set — an
 *  absent `note` key and an empty-string `note` both read as "no note" (mirrors
 *  isSessionResumeEnabled's own absence-is-the-off-state convention). Never throws — a malformed
 *  `note` shape would already have been rejected by RunConfigSchema.parse at read time (see
 *  getRunConfig). */
export function getOperatorNote(runConfig: RunConfig): string | undefined {
  return runConfig.note ? runConfig.note : undefined;
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

/** B-772: this deployment's PINNED per-deployment-profile default model — the last-resort tier of
 *  getModelForGate's three-level fallback, used ONLY when a run carries neither an explicit
 *  `run_config.model.per_gate[<gate>]` nor an explicit `run_config.model.default`. Hand-edited,
 *  never derived from the worker image's own CLI version — the whole point is a value this repo
 *  controls explicitly, so a container image rebuild (which can silently change the CLI's own
 *  undeclared default) never silently changes which model a gate runs on. Keyed the SAME way
 *  src/tools/environment.ts's `KNOWN_REFS` is (`'prod' | 'staging'` project-ref -> name convention)
 *  — see resolveDeploymentProfile below for why the ref->name MAPPING itself is duplicated here
 *  rather than imported. Placeholder alias values — update when this deployment settles on real
 *  per-environment picks; the identity that matters for THIS ticket is "always something explicit
 *  here, never silence". */
export const PINNED_DEFAULT_MODEL_BY_PROFILE: Record<string, string> = {
  prod: 'claude-sonnet-5',
  staging: 'claude-sonnet-5',
};

// B-772: duplicated from src/tools/environment.ts's DEFAULT_SUPABASE_URL/KNOWN_REFS, deliberately
// NOT imported — environment.ts already imports getRunConfig/getOperatorNote FROM this file (its
// own get_project operator_note plumbing), so an import the other way would cycle. This is small,
// stable, rarely-changing data (the same tradeoff environment.ts's own header note about KNOWN_REFS
// documents), so duplication is the accepted cost, not an oversight — keep both maps' key sets in
// sync by hand if a new project ref is ever added.
const DEFAULT_SUPABASE_URL = 'https://eioxsunvhakmelhanmnn.supabase.co';
const KNOWN_REFS_FOR_MODEL: Record<string, string> = {
  eioxsunvhakmelhanmnn: 'prod',
  meqkdgncdzromunylyxf: 'staging',
};

/** Which deployment profile (`'prod'` / `'staging'` / ...) THIS process is talking to, derived from
 *  its own `HARMONY_SUPABASE_URL` the same way environment.ts's `resolveEnvironment` derives
 *  `target` — a hostname-prefix lookup against the known project refs. Falls back to `'prod'` for
 *  an unrecognized/malformed/absent URL (a custom/self-hosted deployment, or a call site with no
 *  Supabase env at all) — never `undefined`: PINNED_DEFAULT_MODEL_BY_PROFILE's own "always
 *  something explicit" guarantee only holds if the LOOKUP KEY itself is never allowed to be
 *  unresolved either. */
function resolveDeploymentProfile(env: NodeJS.ProcessEnv): string {
  const url = env.HARMONY_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  let ref = '';
  try {
    ref = new URL(url).hostname.split('.')[0] ?? '';
  } catch {
    // Malformed URL — ref stays '', falls through to the KNOWN_REFS_FOR_MODEL lookup miss below.
  }
  return KNOWN_REFS_FOR_MODEL[ref] ?? 'prod';
}

/** B-772: the ONE fallback-resolution function every caller (the daemon's fireLaunch, and any
 *  future caller) uses to pick which Claude model a gate's leg runs on — never reimplement this
 *  chain elsewhere. Three levels, in order:
 *    1. `runConfig.model?.per_gate?.[gate]` — an explicit per-gate override for THIS run. Skipped
 *       entirely when `gate` is `null` (no gate resolved — e.g. a terminal-state ticket).
 *    2. `runConfig.model?.default` — an explicit run-wide default for THIS run, when no per-gate
 *       override matched (or none could apply).
 *    3. `PINNED_DEFAULT_MODEL_BY_PROFILE[<this deployment's profile>]` — the hand-edited,
 *       per-deployment pin (see its own doc comment above), resolved via `env` (defaults to
 *       `process.env`, injectable for tests — mirrors this file's own getConductionId/getRunConfig
 *       convention). ALWAYS returns a non-empty string; this is what makes "never the image's
 *       undeclared CLI default" true by construction — there is no fourth level that falls through
 *       to silence. */
export function getModelForGate(
  runConfig: RunConfig,
  gate: Gate | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const perGate = gate ? runConfig.model?.per_gate?.[gate] : undefined;
  if (perGate) return perGate;

  if (runConfig.model?.default) return runConfig.model.default;

  const profile = resolveDeploymentProfile(env);
  return PINNED_DEFAULT_MODEL_BY_PROFILE[profile] ?? PINNED_DEFAULT_MODEL_BY_PROFILE.prod;
}
