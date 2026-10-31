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

import {
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  mkdirSync as nodeMkdirSync,
  existsSync as nodeExistsSync,
  unlinkSync as nodeUnlinkSync,
} from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname as nodeDirname, join as nodeJoin } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { GATES } from '../daemon/gate-phase.js';
import type { Gate } from '../daemon/gate-phase.js';
import { getConduction } from '../tools/conduction-record.js';

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

/** B-773: the five forward gates eligible for the per-run `auto_approve_gates` override — every
 *  `Gate` value EXCEPT `release`/`verify` (the hard floor, never delegable under any mechanism — see
 *  `skills/harmony-conduct/SKILL.md`'s contract 3 and `skills/harmony-shared/gate-routing.md`'s "The
 *  hard floor"). Deliberately `Exclude<Gate, 'release' | 'verify'>` rather than its own hand-written
 *  literal union — see `AUTO_APPROVE_GATE_VALUES` below for why the runtime array driving the zod enum
 *  is ALSO derived from `GATES` (a filter), not an independently hand-typed array; the two must never
 *  drift apart. */
export type AutoApproveGate = Exclude<Gate, 'release' | 'verify'>;

/** The runtime values `AutoApproveGateSchema` accepts — `GATES` (src/daemon/gate-phase.ts's single
 *  source of truth for gate identity) filtered down to the non-floor gates, never an independent
 *  `z.enum([...])` literal: zod needs a runtime array to build an enum from (a TYPE alone erases at
 *  compile time), and deriving it by filtering `GATES` is what keeps this list and `Gate` itself from
 *  ever silently drifting apart (a `GATES` edit is reflected here automatically, filter logic unchanged). */
const AUTO_APPROVE_GATE_VALUES = GATES.filter(
  (gate): gate is AutoApproveGate => gate !== 'release' && gate !== 'verify',
);

// Compile-time pin (this line does nothing at runtime): if a future edit to `GATES` — dropping or
// renaming a gate — ever makes `AUTO_APPROVE_GATE_VALUES`'s inferred element type diverge from
// `AutoApproveGate` (`Exclude<Gate, 'release' | 'verify'>`), this assignment fails to typecheck instead
// of silently building `AutoApproveGateSchema` for the wrong set at runtime.
const _autoApproveGateValuesArePinnedToTheType: readonly AutoApproveGate[] = AUTO_APPROVE_GATE_VALUES;
void _autoApproveGateValuesArePinnedToTheType;

/** B-773: the per-run, per-gate auto-approve override — the human names specific forward gates
 *  (clarify/decompose/design/plan/build; release/verify are structurally excluded, see
 *  `AutoApproveGate` above) that auto-advance for THIS run, layered on top of / independent of the
 *  ambient run mode (controlled / `--pause-at` / `--unattended` / `--escalate`). Consumed by
 *  `harmony-conduct`'s delegation-test step 2a — see `skills/harmony-conduct/SKILL.md`. */
const AutoApproveGateSchema = z.enum(
  AUTO_APPROVE_GATE_VALUES as [AutoApproveGate, ...AutoApproveGate[]],
);

/** B-1257: who may accept the RELEASE gate for this run, when the founder has delegated it. The only
 *  value is `'orchestrator'` — the orchestrator seat, whose accept carries provenance
 *  `agent-synthesized:orchestrator`. Deliberately its own key and NOT a `release` value in
 *  `auto_approve_gates`: that list means the conduct loop synthesizes the accept, and
 *  `AutoApproveGateSchema` structurally excludes release/verify. Here the seat accepts and the leg only
 *  RECOGNISES it. Verify is never delegable by this field. Consumed by `skills/finish-work/SKILL.md` O1
 *  and `skills/harmony-conduct/SKILL.md` §1b (where the cautious Agent-Trust dial vetoes it). */
const ReleaseDelegateSchema = z.enum(['orchestrator']);
export type ReleaseDelegate = z.infer<typeof ReleaseDelegateSchema>;

/** No other axis keys yet — each dependent ticket adds ONE top-level key here.
 *  `.passthrough()` so an accessor build that predates a newer key never throws on it — forward
 *  compatible by construction, same as this ticket's own additive-only design intent. */
export const RunConfigSchema = z
  .object({
    session_resume: SessionResumeSchema,
    note: NoteSchema,
    model: ModelSchema,
    auto_approve_gates: z.array(AutoApproveGateSchema).optional(),
    release_delegate: ReleaseDelegateSchema.optional(),
    /** B-1073: the fast-track flag — a human-invoked `harmony conduct <ticket> --fast-track` run's
     *  single axis key. Mirrors `session_resume`'s own shape (a bare optional boolean, not a nested
     *  `{ enabled }` object — there is no second sub-field this flag will ever need). See
     *  `isFastTrackEnabled` below for the absence/false-both-read-as-disabled convention. */
    fast_track: z.boolean().optional(),
    /** B-1077: which agent adapter (src/agents/registry.ts) this run's legs launch through —
     *  `{ adapter: '<registry id>' }`. Deliberately `z.unknown()` here, NOT a strict object: a
     *  malformed `agent` value must not make the WHOLE payload unparseable (that would silently
     *  disable every other axis — session_resume, note, model, ...). Its shape is judged by
     *  `getAgentAdapter` below instead, which REFUSES a malformed value rather than falling back. */
    agent: z.unknown().optional(),
  })
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

/** B-1073: is fast-track enabled for this run_config payload? Defaults to `false` — an absent
 *  `fast_track` key or an explicit `false` both read as disabled; only `fast_track: true` turns it
 *  on. Never throws — a malformed `fast_track` shape would already have been rejected by
 *  RunConfigSchema.parse at read time (see getRunConfig), so by the time a RunConfig value reaches
 *  this accessor it is trusted. Consumed by `src/daemon/leg-gate.ts`'s `resolveLegGate` (the
 *  fast-track leg-routing wrapper around `resolveGatePhase`) and surfaced read-only via
 *  `src/tools/environment.ts`'s `environment.fast_track`. */
export function isFastTrackEnabled(runConfig: RunConfig): boolean {
  return runConfig.fast_track === true;
}

/** B-743: the operator note for this run_config payload, or `undefined` when none was set — an
 *  absent `note` key and an empty-string `note` both read as "no note" (mirrors
 *  isSessionResumeEnabled's own absence-is-the-off-state convention). Never throws — a malformed
 *  `note` shape would already have been rejected by RunConfigSchema.parse at read time (see
 *  getRunConfig). */
export function getOperatorNote(runConfig: RunConfig): string | undefined {
  return runConfig.note ? runConfig.note : undefined;
}

/** B-773: the set of forward gates this run_config payload auto-approves, or an EMPTY Set when none
 *  were named — an absent `auto_approve_gates` key and an empty array both read as "no override"
 *  (mirrors isSessionResumeEnabled's/getOperatorNote's own absence-is-the-off-state convention). Never
 *  throws — a malformed `auto_approve_gates` shape (a non-array, or an array element outside
 *  `AutoApproveGate`) would already have been rejected by RunConfigSchema.parse at read time (see
 *  getRunConfig), so by the time a RunConfig value reaches this accessor it is trusted. Returns a `Set`
 *  (not an array) because every consumer only ever needs membership (`overrideGates.has(gate)` —
 *  `skills/harmony-conduct/SKILL.md`'s delegation-test step 2a), never order or duplicates. */
export function getAutoApproveGates(runConfig: RunConfig): Set<AutoApproveGate> {
  return new Set(runConfig.auto_approve_gates ?? []);
}

/** B-1257: who this run_config payload delegates the release gate's accept to, or `undefined` when
 *  none — an absent key reads as "no delegate" (the same absence-is-the-off-state convention as
 *  getAutoApproveGates). Never throws — a malformed value would already have been rejected by
 *  RunConfigSchema.parse at read time (see getRunConfig). This reports the RAW run_config choice; the
 *  cautious Agent-Trust dial's veto is applied by the consumer (`harmony-conduct` §1b), exactly as it is
 *  for `auto_approve_gates`. */
export function getReleaseDelegate(runConfig: RunConfig): ReleaseDelegate | undefined {
  return runConfig.release_delegate;
}

/** B-1077: the adapter a run launches through when run_config names none. Equal to
 *  src/agents/registry.ts's DEFAULT_ADAPTER_ID (pinned by run-config.test.ts) — kept as a literal
 *  here so this widely-imported module does not pull the adapter registry into every consumer. */
export const DEFAULT_AGENT_ADAPTER = 'claude-code';

export type AgentAdapterSelection =
  | { ok: true; adapter: string; explicit: boolean }
  | { ok: false; error: string };

/** B-1077: which agent adapter this run_config selects. An ABSENT (or null) `agent` key (or an `agent` object
 *  with no `adapter` key) reads as the default, `claude-code` — so every run_config written before
 *  this axis existed launches exactly as it always did. A PRESENT but malformed value (a non-object
 *  `agent`, a non-string or empty `adapter`) is `ok: false` — never a silent fallback to the
 *  default. Whether a well-formed id is actually REGISTERED is not judged here (that is the
 *  registry's job: src/daemon/agent-eligibility.ts at fire time, src/agents/launch-routing.ts in the
 *  worker). Never throws. */
export function getAgentAdapter(runConfig: RunConfig): AgentAdapterSelection {
  const agent = (runConfig as { agent?: unknown }).agent;
  if (agent === undefined || agent === null) return { ok: true, adapter: DEFAULT_AGENT_ADAPTER, explicit: false };
  if (typeof agent !== 'object' || Array.isArray(agent)) {
    return { ok: false, error: `run_config.agent must be an object like { "adapter": "<id>" }; got ${JSON.stringify(agent)}` };
  }
  const adapter = (agent as { adapter?: unknown }).adapter;
  if (adapter === undefined) return { ok: true, adapter: DEFAULT_AGENT_ADAPTER, explicit: false };
  if (typeof adapter !== 'string' || adapter.trim() === '') {
    return { ok: false, error: `run_config.agent.adapter must be a non-empty adapter id string; got ${JSON.stringify(adapter)}` };
  }
  return { ok: true, adapter, explicit: true };
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

/** B-1000: reads the `HARMONY_LEG` env var — the launcher's leg counter for THIS worker, set
 *  alongside `HARMONY_CONDUCTION_ID` — mirroring getConductionId's own absence-is-fine contract.
 *  Undefined when absent or unparseable (a "was one set, and is it a real integer" query, never a
 *  hard requirement) — this never throws. A non-integer / negative value is treated as absent
 *  rather than passed through, since resolve_brief's p_leg column is a plain `int` and a garbage
 *  caller-side value would otherwise surface as an opaque Postgres cast error deep inside an RPC
 *  instead of cleanly reading as "no leg" here. */
export function getLeg(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = envValue(env, 'HARMONY_LEG');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
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

// =================================================================================================
// B-892: the GATE-BOUNDARY re-read.
//
// Everything above this line resolves run_config from the LAUNCH ENVIRONMENT — the file/inline
// payload the daemon froze into the worker's env when it fired this leg. That snapshot can never
// change while the leg runs, so an operator who edits `conductions.run_config` mid-conduction (from
// the web's Run-options surface) could never reach a leg already in flight.
//
// The fix is to re-read the ROW at each gate boundary, with the launch env as the FALLBACK. The
// consumers are worker-side and per-gate — src/tools/environment.ts's resolveEnvironment (the
// `operator_note` / `auto_approve_gates` the conduct loop reads via get_project) and
// src/cli/commands/model.ts's `resolve-gate`. Deliberately NOT the daemon: the daemon consumes
// `session_resume` at leg LAUNCH, before a worker exists, so that axis stays per-leg by design and
// nothing under src/daemon/ reads this function.
// =================================================================================================

/** B-892: this conduction row's CURRENT `run_config`, or `null` on ANY failure — no client, no
 *  conduction id, an unreadable/missing row, a transport/auth error, or a payload that does not
 *  parse as a RunConfig. NEVER THROWS: it is the same degrade-to-null-never-throw posture
 *  src/tools/environment.ts already documents for `operator_note`/`auto_approve_gates`, and for the
 *  same reason — `get_project` is the first call every conductor run makes, so a run_config the run
 *  cannot do anything about anyway must never break it. A `null` return means "no answer from the
 *  row", which every caller reads as "fall back to the launch env", never as "the operator cleared
 *  the payload" (that case is a successful read returning `{}`).
 *
 *  Reuses src/tools/conduction-record.ts's `getConduction` — the ONE conduction-row accessor —
 *  rather than issuing its own select: `CONDUCTION_COLS` has carried `run_config` since B-718, so
 *  the column comes back already. The resulting config -> tools import is TYPE-ONLY in the other
 *  direction (conduction-record.ts imports `type RunConfig` from this file), so it erases at compile
 *  time and there is no runtime cycle.
 *
 *  Re-parsed through RunConfigSchema rather than trusted: the row is operator/web-authored JSON that
 *  never passed through getRunConfig's own parse, and `.passthrough()` keeps an unrecognized future
 *  key from failing this read (same forward-compat contract as the env path). */
export async function resolveRunConfigFromConduction(
  client: SupabaseClient | null | undefined,
  conductionId: string | null | undefined,
): Promise<RunConfig | null> {
  if (!client || !conductionId) return null;
  try {
    const conduction = await getConduction(client, conductionId);
    const raw = conduction?.run_config;
    if (raw == null) return null;
    const parsed = RunConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
export const PINNED_DEFAULT_MODEL_BY_PROFILE: Record<string, Record<string, string | null>> = {
  'claude-code': {
    prod: 'claude-sonnet-5-5',
    staging: 'claude-sonnet-5-5',
  },
  // B-1147: no hand-pinned Codex model — the live catalog's pinned_default_profiles row is the
  // source; with none, the leg falls back to HARMONY_CODEX_MODEL, then the Codex CLI's own default.
  codex: {
    prod: null,
    staging: null,
  },
};

/** B-1147: the pinned default model for `adapter` on `profile` — the active catalog row of that
 *  agent whose `pinned_default_profiles` contains the profile (when a catalog is given), else the
 *  per-adapter constant above. Claude never returns null (falls back to its prod pin, B-772);
 *  another runtime returns null when nothing is pinned. */
export function getPinnedDefaultModel(
  adapter: string,
  profile: string,
  catalog?: readonly ModelCatalogEntry[] | null,
): string | null {
  if (catalog) {
    const pinnedRow = catalog.find(
      (entry) =>
        entryAgent(entry) === adapter &&
        entry.active !== false &&
        Array.isArray(entry.pinned_default_profiles) &&
        entry.pinned_default_profiles.includes(profile),
    );
    if (pinnedRow) return entryModelId(pinnedRow);
  }
  const byProfile = PINNED_DEFAULT_MODEL_BY_PROFILE[adapter];
  if (adapter === DEFAULT_AGENT_ADAPTER) {
    const claude = PINNED_DEFAULT_MODEL_BY_PROFILE[DEFAULT_AGENT_ADAPTER];
    return claude[profile] ?? (claude.prod as string);
  }
  return byProfile?.[profile] ?? null;
}

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
 *  unresolved either.
 *
 *  B-1025: an `overrideUrl` (the resolved target's URL — the active project's stored URL when
 *  one is set, ahead of env) lets the CLI caller pass the URL the exchange will actually use, so
 *  the profile lookup matches what `harmony login` registered. Without this, a registered
 *  staging project on a host with no `HARMONY_SUPABASE_URL` set would report 'prod' here while
 *  the exchange talks to staging — a CLI that says one target and uses another. */
export function resolveDeploymentProfile(
  env: NodeJS.ProcessEnv = process.env,
  overrideUrl?: string,
): string {
  const url = overrideUrl ?? env.HARMONY_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
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
  catalog?: readonly ModelCatalogEntry[] | null,
): string {
  const perGate = gate ? runConfig.model?.per_gate?.[gate] : undefined;
  const explicit = perGate || runConfig.model?.default;
  if (explicit) {
    const selection = getAgentAdapter(runConfig);
    // B-1349: an explicitly named model normalizes against inactive rows too, so a run that names an
    // inactive offer resolves to the same bare id provision.sh launched it with (`normalize
    // --offered-only` includes inactive) — otherwise the leg's step-1d self-check sees a mismatch.
    return catalog
      ? normalizeModelId(explicit, catalog, selection.ok ? selection.adapter : DEFAULT_AGENT_ADAPTER, { includeInactive: true })
      : explicit;
  }

  // B-1349: the pinned-default tier below stays active-only — getPinnedDefaultModel already skips
  // `active === false` rows, so an inactive row is never chosen as a default.

  // B-1147: the pinned tier is per-adapter. A malformed `agent` reads as claude-code HERE (the
  // launch path refuses it separately — getAgentAdapter's own callers); for a non-Claude runtime
  // with nothing pinned this returns '' — "no model resolved", which the mint script omits
  // (composeModelLine) and provision.sh reads as "use HARMONY_CODEX_MODEL, else the CLI default".
  const selection = getAgentAdapter(runConfig);
  const adapter = selection.ok ? selection.adapter : DEFAULT_AGENT_ADAPTER;
  const profile = resolveDeploymentProfile(env);
  if (adapter === DEFAULT_AGENT_ADAPTER && !catalog) {
    const claude = PINNED_DEFAULT_MODEL_BY_PROFILE[DEFAULT_AGENT_ADAPTER];
    return (claude[profile] ?? claude.prod) as string;
  }
  return getPinnedDefaultModel(adapter, profile, catalog) ?? '';
}

// =================================================================================================
// B-881: the LIVE model catalog. Replaces the B-772-round-2 hand-maintained MODEL_ALIAS_ALLOWLIST /
// MODEL_CONTEXT_BUDGET_BYTES tables (which had drifted from harmony-web's own hand-maintained
// MODEL_OPTIONS list, and — worse — carried `claude-haiku-5`, a model that has never existed, right
// through three test files' assertions). The single source of truth is now the `model_catalog`
// Supabase table (harmony-web migration: `alias TEXT PRIMARY KEY, label TEXT NOT NULL,
// context_budget_bytes BIGINT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, verified_at
// TIMESTAMPTZ`), read live via `fetchModelCatalog`/`resolveModelCatalog` below, filtered to
// `active = true`. Both `isAllowedModelAlias` and `getModelContextBudgetBytes` are now ASYNC — they
// take a live trip through the catalog (client-injected, mirroring resolveRunConfigFromConduction's
// own `(client, ...)` shape rather than reaching for a client themselves) before ever falling back.
//
// TABLE-ABSENT TOLERANCE (B-383 prod-before-promote — load-bearing, not incidental): harmony-web's
// migration that creates `model_catalog` merges and promotes on its OWN schedule, independent of
// this repo's. Until it has actually landed on whichever Supabase project this code is running
// against (prod lags staging lags a fresh migration), every read here must see the table as simply
// ABSENT and degrade exactly the same way it would for a network failure — never throw, never treat
// "relation does not exist" as a bug. See fetchModelCatalog below.
//
// Consumed by BASH (container/provision.sh, container/entrypoint.sh) via the node subprocess
// accessor (src/cli/commands/model.ts's `harmony model ...` subcommands) — mirroring the existing
// `harmony config get` precedent (container/cloud-worker-launch.sh:70) — never hand-duplicated as an
// independent bash copy.
// =================================================================================================

/** One live row of the `model_catalog` table (or a fallback entry shaped identically — see
 *  MODEL_CATALOG_FALLBACK below). `verified_at` is carried through for completeness — it was the
 *  B-881 liveness script's bookkeeping column, and nothing writes it since B-1104 retired that
 *  script — but nothing in this file reads it; it plays no role in allow/deny or budget decisions. */
export interface ModelCatalogEntry {
  alias: string;
  label: string;
  context_budget_bytes: number;
  active: boolean;
  verified_at: string | null;
  /** B-1147: which agent runtime (src/agents/registry.ts id) this row's model runs on. Absent on
   *  the pre-B-1147 table shape — read as 'claude-code' (see entryAgent). */
  agent?: string;
  /** B-1147: the runtime-native model id (what is passed to the runtime's CLI). Absent on the old
   *  shape — read as `alias` (see entryModelId). */
  model_id?: string;
  /** B-1147: the provider model this id maps to, when it differs; null = same as model_id. */
  underlying_model?: string | null;
  /** B-1147: free-form capability flags. */
  capabilities?: Record<string, unknown>;
  /** Which deployment profiles ('prod' / 'staging') pin this row as their default, when the
   *  column exists. */
  pinned_default_profiles?: string[] | null;
  /** B-1178: which model provider serves this row (src/agents/codex-providers.ts). Absent (the column
   *  predates the migration on this project) or null reads as the runtime's default — see entryProvider. */
  provider?: string | null;
  /** B-1178: the model's context window in tokens, when the catalog knows it. Absent or null means
   *  "omit model_context_window" from a Codex provider config. */
  context_window_tokens?: number | null;
}

/** B-1147: a catalog row's agent — 'claude-code' for any row predating the agent column. */
export function entryAgent(entry: ModelCatalogEntry): string {
  return entry.agent || DEFAULT_AGENT_ADAPTER;
}

/** B-1147: a catalog row's runtime-native model id — the alias for any row predating model_id. */
export function entryModelId(entry: ModelCatalogEntry): string {
  return entry.model_id || entry.alias;
}

/** B-1178: the provider each runtime means when a row names none (or the column is absent). */
export const DEFAULT_PROVIDER_BY_AGENT: Readonly<Record<string, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** B-1178: a catalog row's model provider — its `provider` when that is a non-empty string, else the
 *  runtime's default (`openai` for codex rows, `anthropic` for claude-code rows). Until the column lands on
 *  a project every row reads as its default, so every leg launches exactly as before (AC6). */
export function entryProvider(entry: ModelCatalogEntry): string {
  if (typeof entry.provider === 'string' && entry.provider !== '') return entry.provider;
  return DEFAULT_PROVIDER_BY_AGENT[entryAgent(entry)] ?? DEFAULT_PROVIDER_BY_AGENT[DEFAULT_AGENT_ADAPTER];
}

/** B-1147: the catalog rows that run on `agent`. */
export function catalogEntriesForAgent(
  entries: readonly ModelCatalogEntry[],
  agent: string = DEFAULT_AGENT_ADAPTER,
): ModelCatalogEntry[] {
  return entries.filter((entry) => entryAgent(entry) === agent);
}

/** B-1178: the explicit-name opt-in. A run that NAMES an inactive offer still launches (AC7): inactive
 *  only hides a row from lists and dialogs. Only the explicit-name paths pass it (isAllowedModelAlias,
 *  getModelContextBudgetBytes, `model normalize`, runtime-validation, `harmony agent provider`); every list
 *  and default path stays active-only. */
export interface CatalogReadOptions {
  includeInactive?: boolean;
}

/** B-1185: match either spelling only within active rows of the selected runtime.
 * Unknown values pass through for the caller's existing refusal; never strip a prefix.
 * B-1178: `{ includeInactive: true }` also matches an `active === false` row — explicit names only. */
export function findModelEntry(
  model: string,
  entries: readonly ModelCatalogEntry[],
  agent: string = DEFAULT_AGENT_ADAPTER,
  opts: CatalogReadOptions = {},
): ModelCatalogEntry | undefined {
  return catalogEntriesForAgent(entries, agent).find(
    (entry) => (entry.active || opts.includeInactive === true) && (entry.alias === model || entryModelId(entry) === model),
  );
}

export function normalizeModelId(
  model: string,
  entries: readonly ModelCatalogEntry[],
  agent: string = DEFAULT_AGENT_ADAPTER,
  opts: CatalogReadOptions = {},
): string {
  const entry = findModelEntry(model, entries, agent, opts);
  return entry ? entryModelId(entry) : model;
}

/** B-1147: is `error` Postgres "undefined column" (42703) or PostgREST's schema-cache miss for a
 *  column (PGRST204) — i.e. the web migration adding the runtime columns has not landed here yet. */
export function isMissingCatalogColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === '42703' || e.code === 'PGRST204') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /column .* does not exist/i.test(msg) || /could not find the .* column/i.test(msg);
}

/** B-881: the embedded, DEGRADE-ONLY safety net — consulted ONLY when `model_catalog` is
 *  unreachable (a network failure, or the table-absent case: the harmony-web migration that creates
 *  it hasn't landed on this environment's Supabase project yet). Once the catalog is reachable it is
 *  ALWAYS authoritative and this list is never consulted again for that call — catalog-vs-fallback
 *  drift only matters during an outage/pre-migration window, never otherwise.
 *
 *  Deliberately minimal: today's known-real aliases only, cross-checked against
 *  PINNED_DEFAULT_MODEL_BY_PROFILE's existing values and this repo's own attested names (this build
 *  has no access to harmony-web's MODEL_OPTIONS list to diff against directly). THIS MUST NEVER
 *  BECOME A SECOND PLACE TO ADD A NEW MODEL — the only edits it should ever need are removing a
 *  retired model, or, in an emergency, keeping the pinned-default invariant below satisfiable.
 *  Context budgets follow the same conservative-bias convention as
 *  DEFAULT_MODEL_CONTEXT_BUDGET_BYTES: the smallest tabled tier for anything not certain (here,
 *  every tier except the Sonnet and Opus rows this repo has long pinned defaults or routed gates to;
 *  B-1096 refreshed the list to the current generation). */
export const MODEL_CATALOG_FALLBACK: readonly ModelCatalogEntry[] = [
  {
    alias: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    context_budget_bytes: 150 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-sonnet-5-5',
  },
  {
    alias: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    context_budget_bytes: 150 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-sonnet-5',
  },
  {
    alias: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    context_budget_bytes: 150 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-opus-5-5',
  },
  {
    alias: 'claude-opus-5',
    label: 'Claude Opus 5',
    context_budget_bytes: 150 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-opus-5',
  },
  {
    alias: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    context_budget_bytes: 60 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-haiku-5-5',
  },
  {
    alias: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    context_budget_bytes: 60 * 1024 * 1024,
    active: true,
    verified_at: null,
    agent: 'claude-code',
    model_id: 'claude-fable-5-1',
  },
];

// Runtime guard (not just a doc claim): every PINNED_DEFAULT_MODEL_BY_PROFILE value must be a
// member of MODEL_CATALOG_FALLBACK — thrown at import time (module init), so a future edit to
// either table that lets them drift apart fails LOUD (an import-time throw a test/build catches
// immediately) rather than surfacing later as a silently-unrequestable pinned default WHILE THE
// CATALOG IS UNREACHABLE (the only window the fallback is ever consulted at all — see this ticket's
// module header). This is the B-772 round-2 invariant, re-homed against the fallback list now that
// there is no synchronous, always-available MODEL_ALIAS_ALLOWLIST to check it against.
for (const pinned of Object.values(PINNED_DEFAULT_MODEL_BY_PROFILE[DEFAULT_AGENT_ADAPTER])) {
  if (!MODEL_CATALOG_FALLBACK.some((entry) => entry.alias === pinned)) {
    throw new Error(
      `B-881 invariant violated: PINNED_DEFAULT_MODEL_BY_PROFILE value '${pinned}' is missing from MODEL_CATALOG_FALLBACK`,
    );
  }
}

/** Conservative default budget for an alias absent from the resolved catalog (an allowed but
 *  not-yet-tabled alias, or a caller that passes something outside the catalog entirely) — never
 *  throws, mirrors getModelForGate's own "always something explicit, never silence" discipline.
 *  Deliberately the SMALLEST tabled budget across the fallback list rather than the largest — an
 *  unrecognized alias should bias the guard toward cold-starting, not toward assuming it can afford
 *  the biggest window on file. */
const DEFAULT_MODEL_CONTEXT_BUDGET_BYTES = 60 * 1024 * 1024;

/** B-881: best-effort live read of `model_catalog`'s active rows, or `null` on ANY failure — no
 *  client (silent — mirrors resolveRunConfigFromConduction's own "no client -> null, no log"
 *  convention: an unauthenticated caller is an ordinary, expected shape), or a REAL attempt against
 *  a real client that failed: a network/transport error, an auth/permission error, or — the
 *  load-bearing case — the table not existing yet on this environment (harmony-web's migration
 *  hasn't landed here). That second class ALWAYS logs a WARNING to stderr before returning `null` —
 *  this is the one accepted plan-gate pin this ticket must prove with an EXECUTED test (a mocked
 *  "relation does not exist" error must degrade exactly like any other unreachable-catalog failure,
 *  never throw). NEVER THROWS: a `null` return means "no answer", which every caller reads as "fall
 *  back to MODEL_CATALOG_FALLBACK", never as "the catalog is legitimately empty" (an
 *  empty-but-reachable catalog also degrades to the fallback — see resolveModelCatalog below —
 *  since a reachable-but-empty catalog can never satisfy the pinned-default invariant either). */
export async function fetchModelCatalog(
  client: SupabaseClient | null | undefined,
  opts: CatalogReadOptions = {},
): Promise<ModelCatalogEntry[] | null> {
  if (!client) return null;
  try {
    // B-1147: select the runtime columns first; on an undefined-column error (the web migration
    // has not landed on this project yet — prod until promote) re-select the pre-B-1147 shape and
    // label every row claude-code with model_id = alias.
    // B-1178: a NEW top rung also selects provider and context_window_tokens; on a missing-column
    // error it falls through to the rungs below, unchanged. `includeInactive` (explicit-name callers
    // only) drops the active filter on every rung.
    type CatalogRead = { data: unknown; error: { code?: string; message?: string } | null };
    const read = async (cols: string): Promise<CatalogRead> => {
      const query = client.from('model_catalog').select(cols);
      return (await (opts.includeInactive ? query : query.eq('active', true))) as CatalogRead;
    };
    const B1147_COLS =
      'alias, label, context_budget_bytes, active, verified_at, agent, model_id, underlying_model, capabilities, pinned_default_profiles';
    let { data, error }: CatalogRead = await read(`${B1147_COLS}, provider, context_window_tokens`);
    if (error && isMissingCatalogColumnError(error)) {
      ({ data, error } = await read(B1147_COLS));
    }
    if (error && isMissingCatalogColumnError(error)) {
      // pinned_default_profiles may predate the runtime columns or not exist at all — try without it.
      ({ data, error } = await read('alias, label, context_budget_bytes, active, verified_at, agent, model_id, underlying_model, capabilities'));
    }
    if (error && isMissingCatalogColumnError(error)) {
      ({ data, error } = await read('alias, label, context_budget_bytes, active, verified_at'));
    }
    if (error) {
      console.error(
        `harmony model_catalog: WARNING — the live catalog was unreachable (${error.message ?? String(error)}); ` +
          'degrading to the embedded MODEL_CATALOG_FALLBACK list. This is the EXPECTED shape while ' +
          "harmony-web's model_catalog migration has not yet landed on this environment's Supabase " +
          'project (B-383 prod-before-promote) — never treat this as a bug on its own.',
      );
      return null;
    }
    if (!data) return null;
    return (data as unknown as ModelCatalogEntry[]).map((row) => ({
      ...row,
      agent: entryAgent(row),
      model_id: entryModelId(row),
    }));
  } catch (err: unknown) {
    console.error(
      `harmony model_catalog: WARNING — reading the live catalog threw (${(err as Error)?.message ?? String(err)}); ` +
        'degrading to the embedded MODEL_CATALOG_FALLBACK list.',
    );
    return null;
  }
}

/** B-881: the ONE catalog-resolution function every caller (isAllowedModelAlias,
 *  getModelContextBudgetBytes, and src/cli/commands/model.ts's `list-aliases`) goes through — live
 *  catalog when reachable and non-empty, else MODEL_CATALOG_FALLBACK. Never throws. The WARNING for
 *  an actual reachability failure is logged inside fetchModelCatalog above (it knows WHY); this
 *  function only adds its own warning for the reachable-but-EMPTY case, which fetchModelCatalog
 *  cannot distinguish from "no rows yet" on its own. */
export async function resolveModelCatalog(
  client: SupabaseClient | null | undefined,
  opts: CatalogReadOptions = {},
): Promise<{ entries: readonly ModelCatalogEntry[]; source: 'live' | 'fallback' }> {
  const live = await fetchModelCatalog(client, opts);
  if (live && live.length > 0) return { entries: live, source: 'live' };
  if (live && live.length === 0) {
    console.error(
      'harmony model_catalog: WARNING — the live catalog is reachable but has zero active rows; ' +
        'degrading to the embedded MODEL_CATALOG_FALLBACK list.',
    );
  }
  return { entries: MODEL_CATALOG_FALLBACK, source: 'fallback' };
}

/** B-881: is `alias` one this deployment allows a model-switch handoff to request? Never throws —
 *  resolves the live catalog (falling back to MODEL_CATALOG_FALLBACK when unreachable) and checks
 *  membership. `client` is OPTIONAL/nullable: pass `null`/`undefined` (or omit it) to check against
 *  the fallback list only, exactly as every call site does when it could not authenticate. Consumed
 *  directly by src/cli/commands/model.ts's `check-alias` and `request-switch` subcommands (the ONLY
 *  two places that ever gate a handoff write/consume on this), and by the invariant loop above at
 *  import time (which checks the FALLBACK list directly, not through this function, since it runs
 *  before any client can exist). */
export async function isAllowedModelAlias(
  alias: string,
  client?: SupabaseClient | null,
  agent: string = DEFAULT_AGENT_ADAPTER,
): Promise<boolean> {
  // B-1178: an explicit name — an inactive row still passes (inactive only hides it from lists).
  const { entries } = await resolveModelCatalog(client, { includeInactive: true });
  // B-1185: accept catalog aliases and runtime ids within the selected runtime.
  return !!findModelEntry(alias, entries, agent, { includeInactive: true });
}

/** B-881: per-model resumable-session-SIZE budget, in BYTES — the narrowed session-resume guard's
 *  threshold (container/provision.sh same-conduction, container/entrypoint.sh cross-conduction) for
 *  "would resuming THIS model on THIS session likely blow its context window". Bytes, not tokens:
 *  both guard sites compare directly against a JSONL transcript's `stat`/`ls`-reported file SIZE —
 *  converting that to a token count would need the transcript's actual tokenizer, unavailable to a
 *  bash guard — so this is a deliberately ROUGH, CONSERVATIVE estimate (JSONL's per-message
 *  protocol overhead skews any fixed bytes-per-token ratio, so this is not exact accounting). A
 *  conservative UNDER-estimate is the accepted failure mode (erring toward cold-starting more often
 *  than strictly necessary costs a bit of redundant context-gathering) — an incorrectly ALLOWED
 *  resume that then blows the context window mid-leg is far more expensive. Exposed to bash via
 *  `harmony model context-budget <alias>` (src/cli/commands/model.ts) — NEVER hand-duplicate this
 *  table in provision.sh/entrypoint.sh. Never throws; always returns a number (see
 *  DEFAULT_MODEL_CONTEXT_BUDGET_BYTES's own doc comment for the fallback's direction). `client` is
 *  OPTIONAL/nullable, same convention as isAllowedModelAlias. */
export async function getModelContextBudgetBytes(
  alias: string,
  client?: SupabaseClient | null,
  agent?: string,
): Promise<number> {
  // B-1178: an explicit name — an inactive row's budget still applies.
  const { entries } = await resolveModelCatalog(client, { includeInactive: true });
  // B-1148: with an agent, match that runtime's rows on their runtime-native model id (a Codex
  // rollout is weighed against the Codex row's budget, never a Claude row). Without one the
  // pre-B-1148 alias match is unchanged.
  const found = agent
    ? findModelEntry(alias, entries, agent, { includeInactive: true })
    : entries.find((entry) => entry.alias === alias);
  return found?.context_budget_bytes ?? DEFAULT_MODEL_CONTEXT_BUDGET_BYTES;
}

/** B-772: the model-switch handoff-file contract. A gate-owning agent turn (step 1d,
 *  skills/harmony-conduct/SKILL.md) that detects a mismatch between the gate it is about to work
 *  and the model its running `claude` process was launched with writes ONE of these, then ends its
 *  turn WITHOUT doing the gate's work. container/provision.sh's bounded switch loop reads it right
 *  after each `claude` invocation returns, to decide whether to re-invoke with a different
 *  `--model`. Deliberately a FILE, never an exit code — the CLI's own exit code stays reserved for
 *  the daemon's exit classifier (src/daemon/scheduler.ts), which this ticket does not touch. */
export interface ModelHandoffRequest {
  /** The alias the next `claude` invocation should launch with. NOT pre-validated by this
   *  interface — every reader (src/cli/commands/model.ts's `read-handoff`/`consume` paths,
   *  container/provision.sh's loop) must still run it through `isAllowedModelAlias` /
   *  `harmony model check-alias` before ever interpolating it into a shell argument. */
  requested_model: string;
}

const DEFAULT_MODEL_HANDOFF_FILENAME = 'model-handoff-request.json';

/** B-772: where the handoff file lives for THIS process's env — an env-var override
 *  (`HARMONY_MODEL_HANDOFF_PATH`) for test/deployment-profile flexibility, else a fixed path under
 *  `$HOME/.harmony/` (mirrors src/config/deployment-config.ts's own `~/.harmony/` convention),
 *  which is a real, per-container, per-conduction-leg-shared directory on every launch profile
 *  (same `$HOME` the switch loop's shell and the agent's own Bash tool calls both see) — so the
 *  agent's write and provision.sh's read always agree on the path with zero extra wiring. Never
 *  throws (a plain string-join). */
export function getModelHandoffPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = envValue(env, 'HARMONY_MODEL_HANDOFF_PATH');
  if (override) return override;
  const home = env.HOME ?? nodeHomedir();
  return nodeJoin(home, '.harmony', DEFAULT_MODEL_HANDOFF_FILENAME);
}

/** B-772: write a handoff request. Creates the parent directory if needed (a fresh container's
 *  `$HOME/.harmony/` may not exist yet). Overwrites any prior pending request — only the LATEST
 *  request from the LATEST turn is ever meaningful; there is no queue. Callers (specifically
 *  src/cli/commands/model.ts's `request-switch`) are responsible for validating `alias` against
 *  `isAllowedModelAlias` BEFORE calling this — this function itself does not validate, so it stays
 *  a pure "write what I'm given" primitive other future callers can also use safely once they do
 *  their own validation. */
export function writeModelHandoffRequest(alias: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = getModelHandoffPath(env);
  nodeMkdirSync(nodeDirname(path), { recursive: true });
  const payload: ModelHandoffRequest = { requested_model: alias };
  nodeWriteFileSync(path, JSON.stringify(payload));
}

/** B-772: read the pending handoff request, or `null` when none is pending / the file is malformed
 *  / unreadable. Never throws — a best-effort read, matching every other guard in this ticket
 *  (container/provision.sh's own best-effort philosophy for run_config reads). Does NOT delete the
 *  file — pair with `clearModelHandoffRequest` after consuming (see src/cli/commands/model.ts's
 *  `read-handoff` + `clear-handoff`, called as two distinct shell steps so provision.sh's loop can
 *  validate the alias BEFORE clearing — an invalid alias still gets cleared, just via an explicit
 *  second call, never silently left to be misread as still-pending on the next iteration). */
export function readModelHandoffRequest(env: NodeJS.ProcessEnv = process.env): ModelHandoffRequest | null {
  const path = getModelHandoffPath(env);
  if (!nodeExistsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(nodeReadFileSync(path, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'requested_model' in parsed &&
      typeof (parsed as { requested_model: unknown }).requested_model === 'string' &&
      (parsed as { requested_model: string }).requested_model
    ) {
      return { requested_model: (parsed as { requested_model: string }).requested_model };
    }
    return null;
  } catch {
    return null;
  }
}

/** B-772: delete the pending handoff request file, if any. Idempotent — a missing file is not an
 *  error (ENOENT is swallowed); any OTHER error (e.g. a permission failure) still throws, since
 *  that is a genuine environment problem worth surfacing rather than silently masking. */
export function clearModelHandoffRequest(env: NodeJS.ProcessEnv = process.env): void {
  const path = getModelHandoffPath(env);
  try {
    nodeUnlinkSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}
