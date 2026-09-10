// B-991: the project gate manifest — `.harmony/project.yml`, a versioned, per-repo declaration of
// build-isolation preconditions, release-prep lookups, and in-leg gate extension points, read by
// the `harmony gates run <extension-point>` CLI runner (src/cli/commands/gates.ts). Ships to EVERY
// installed plugin, so the floor matters: a project with NO manifest, or one present but declaring
// nothing for a given gate, MUST behave identically to today's hand-copied-CLAUDE.md-prose world —
// see loadProjectManifest's and getStepsForExtensionPoint's own doc comments for exactly where that
// floor is enforced.
//
// Schema conventions here deliberately DIVERGE from src/config/run-config.ts's `.passthrough()`
// forward-compat posture: run-config.ts is a LAUNCH-TIME payload this same build always produces
// and consumes, so an unrecognized key is expected to come from a NEWER build than the one reading
// it. A project manifest is hand-authored, per-repo, versioned prose — an unrecognized top-level key
// is far more likely a typo than a forward-compat future key, so this schema fails LOUD on one
// instead (AC5). The single `version` key is the seam that would carry a real future schema
// revision, the same way DeploymentConfigSchema (src/config/deployment-config.ts) does not need
// passthrough either — both are versioned config files, not wire payloads between build revisions.
//
// Five keys, exactly the ratified design: `version`, `preconditions` (declared data, NEVER
// executed — see the safety-relevant test in project-manifest.test.ts proving this), and the three
// extension points `build.before_pr` / `release.before_merge` / `verify.before_ack`, each an
// ordered list of `run:` or `agent_task:` steps.
//
// B-992: the PreToolUse hook (src/hooks/pretooluse-gate.ts) reads back a local, gitignored
// EVIDENCE MARKER per extension point at `.harmony/.gate-evidence/<extension-point>.json`,
// written atomically by `harmony gates run <extension-point>` (src/cli/commands/gates.ts) after
// a fully successful run — no logic here, just the convention this file's own directory sits
// beside.

import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { join as nodeJoin, resolve as nodeResolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Where the manifest lives, relative to a project's repo root. Exported so the CLI runner and any
 *  skill prose pointing at "the manifest path" read it from ONE place rather than a hand-typed
 *  string duplicated at each call site. */
export const PROJECT_MANIFEST_RELATIVE_PATH = '.harmony/project.yml';

/** The only `version` this v1 runner recognizes. A manifest naming any other value — including a
 *  plausible-looking future version — is malformed (AC5's "unrecognized version"), never silently
 *  accepted: this runner has no idea what a version-2 manifest means yet. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export const EXTENSION_POINTS = ['build.before_pr', 'release.before_merge', 'verify.before_ack'] as const;
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

// --- step schema --------------------------------------------------------------------------------

/** A `run:` step — a shell command executed as a subprocess by the CLI runner (src/cli/commands/
 *  gates.ts). The schema RECOGNIZES `agent_task:` (below) so a manifest using it still PARSES —
 *  only the v1 CLI runner refuses to execute it, and only for the extension point that names it
 *  (see getStepsForExtensionPoint's stepErrors). */
const RunStepSchema = z.object({ run: z.string().min(1) }).strict();

/** An `agent_task:` step — recognized by the schema (parses cleanly) but NOT executed by the v1 CLI
 *  runner. A manifest step using this keyword fails loud for its own extension point only when that
 *  extension point is invoked — never silently ignored, never wedges any OTHER extension point. */
const AgentTaskStepSchema = z.object({ agent_task: z.string().min(1) }).strict();

const StepSchema = z.union([RunStepSchema, AgentTaskStepSchema]);
export type ManifestStep = z.infer<typeof StepSchema>;

export function isRunStep(step: ManifestStep): step is { run: string } {
  return 'run' in step;
}
export function isAgentTaskStep(step: ManifestStep): step is { agent_task: string } {
  return 'agent_task' in step;
}

const GateSchema = z.object({ before_pr: z.array(StepSchema).optional() }).strict();
const ReleaseGateSchema = z.object({ before_merge: z.array(StepSchema).optional() }).strict();
const VerifyGateSchema = z.object({ before_ack: z.array(StepSchema).optional() }).strict();

/** The 5-key top-level schema. Deliberately `.strict()` (see this file's header) — an unrecognized
 *  top-level key is AC5's own "malformed" example, not a forward-compat pass-through case. */
const ProjectManifestBodySchema = z
  .object({
    version: z.literal(SUPPORTED_MANIFEST_VERSION),
    preconditions: z.array(z.string()).optional(),
    build: GateSchema.optional(),
    release: ReleaseGateSchema.optional(),
    verify: VerifyGateSchema.optional(),
  })
  .strict();

export type ProjectManifest = z.infer<typeof ProjectManifestBodySchema>;

// --- result / error shapes ------------------------------------------------------------------------

/** Why a manifest (or one of its extension points) is malformed — see loadProjectManifest's own doc
 *  comment for which reasons are WHOLE-FILE (every extension point fails loud) vs SCOPED to one
 *  extension point (the others stay unaffected). */
export type MalformedReason =
  | 'invalid-yaml'
  | 'not-a-mapping'
  | 'unknown-key'
  | 'missing-version'
  | 'unrecognized-version'
  | 'invalid-shape'
  | 'missing-script'
  | 'unsupported-agent-task';

/** A single classified problem, always carrying the file path (AC5: "it names the file and the
 *  specific problem") and a human-readable message ready to print as-is. */
export interface ManifestProblem {
  file: string;
  reason: MalformedReason;
  message: string;
}

/** A per-extension-point problem detected AFTER the manifest as a whole parsed successfully — a
 *  `run:` step naming a script absent from disk, or an `agent_task:` step. These are SCOPED: only
 *  the extension point that declared the bad step is affected, every other extension point in the
 *  same, otherwise-valid manifest runs normally. */
export type StepErrorsByExtensionPoint = Partial<Record<ExtensionPoint, ManifestProblem>>;

export type ManifestLoadResult =
  | { kind: 'absent' }
  | { kind: 'malformed'; problem: ManifestProblem }
  | { kind: 'ok'; file: string; manifest: ProjectManifest; stepErrors: StepErrorsByExtensionPoint };

export interface LoadProjectManifestDeps {
  /** Injectable so this loader is unit-testable without touching the real filesystem — mirrors
   *  src/config/run-config.ts's getRunConfig readFileSync injection convention. */
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
}

const KNOWN_TOP_LEVEL_KEYS = ['version', 'preconditions', 'build', 'release', 'verify'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first whitespace-delimited token of a `run:` command string — e.g. `"./scripts/foo.sh --x"`
 *  -> `"./scripts/foo.sh"`, `"npm run build"` -> `"npm"`. Deliberately NOT a real shell parse (no
 *  quoting/escaping support) — this is only ever used to decide whether the command NAMES A SCRIPT
 *  FILE worth existence-checking, never to actually invoke anything. */
function firstToken(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? '';
}

/** Does this `run:` command's first token look like a script PATH (as opposed to a bare executable
 *  name resolved off `$PATH`, e.g. `npm`, `make`)? Anything containing a path separator — `./foo.sh`,
 *  `scripts/foo.sh`, `/abs/foo.sh` — is treated as a script reference and existence-checked relative
 *  to the project root (AC2's "a `run:` step naming a script that does not exist on disk"). A bare
 *  command name is NOT checked — this is what lets the dogfood manifest's own `npm run build` /
 *  `npm run verify:dist` steps (step 10 of this ticket's plan) parse and run without this runner
 *  demanding an `npm` file exist in the repo. */
function looksLikeScriptPath(token: string): boolean {
  return token.includes('/');
}

/** Validate every `run:` step's script existence, and flag every `agent_task:` step, for ONE
 *  extension point's step list. Returns the first problem found (a manifest step list validates
 *  fail-fast, same posture as manageTestCases' own "validate everything before any write"
 *  convention) or `undefined` when the list is clean. */
function validateSteps(
  file: string,
  extensionPoint: ExtensionPoint,
  steps: ManifestStep[] | undefined,
  projectRoot: string,
  existsSync: (path: string) => boolean,
): ManifestProblem | undefined {
  if (!steps) return undefined;
  for (const step of steps) {
    if (isAgentTaskStep(step)) {
      return {
        file,
        reason: 'unsupported-agent-task',
        message:
          `${file}: ${extensionPoint} declares an 'agent_task:' step ('${step.agent_task}') — the v1 ` +
          "'harmony gates run' runner does not execute agent_task steps. This extension point runs " +
          'NO steps until the manifest is updated; other extension points are unaffected.',
      };
    }
    const token = firstToken(step.run);
    if (looksLikeScriptPath(token)) {
      const resolved = nodeResolve(projectRoot, token);
      if (!existsSync(resolved)) {
        return {
          file,
          reason: 'missing-script',
          message:
            `${file}: ${extensionPoint}'s run step '${step.run}' names a script that does not exist ` +
            `on disk (looked for ${resolved}). This extension point runs NO steps until the manifest ` +
            'is fixed; other extension points are unaffected.',
        };
      }
    }
  }
  return undefined;
}

/** Load and classify `<projectRoot>/.harmony/project.yml`.
 *
 *  Three top-level outcomes:
 *   - `'absent'` — no manifest file. Every extension point is a no-op (AC4's floor).
 *   - `'malformed'` — a WHOLE-FILE problem (invalid YAML, non-mapping top level, an unknown
 *     top-level key, a missing/unrecognized `version`): the shape could not be determined AT ALL, so
 *     every extension point this manifest would have declared runs no steps. Never thrown — always
 *     returned, so a caller (the CLI runner) can print the file + reason and choose its own exit
 *     code (AC5: "fails loud: it names the file and the specific problem").
 *   - `'ok'` — the manifest parsed and its shape is valid. `stepErrors` may still carry PER-
 *     EXTENSION-POINT problems (a missing script, an unsupported `agent_task:` step) that are
 *     scoped to just that extension point — every other extension point in the same manifest is
 *     unaffected, satisfying AC5's "never crashes any OTHER gate".
 *
 *  Never throws under any condition covered by this ticket's ACs — a caller that wants a hard
 *  failure decides that itself from the returned `kind`. */
export function loadProjectManifest(
  projectRoot: string,
  deps: LoadProjectManifestDeps = {},
): ManifestLoadResult {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const readFileSync = deps.readFileSync ?? ((p: string) => nodeReadFileSync(p, 'utf8'));

  const file = nodeJoin(projectRoot, PROJECT_MANIFEST_RELATIVE_PATH);
  if (!existsSync(file)) return { kind: 'absent' };

  const raw = readFileSync(file);

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'invalid-yaml',
        message: `${file}: invalid YAML — ${(err as { message?: string })?.message ?? String(err)}`,
      },
    };
  }

  // An empty file (or a file that is only comments/whitespace) parses to `undefined` — never
  // silently coerced into a valid "present-but-empty" manifest (that state requires an EXPLICIT
  // `version: 1` with nothing else — see this file's header). Falls through to the missing-version
  // check below via the empty-object substitution.
  if (parsed === undefined || parsed === null) parsed = {};

  if (!isPlainObject(parsed)) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'not-a-mapping',
        message: `${file}: the manifest's top level must be a YAML mapping (object), got ${
          Array.isArray(parsed) ? 'a sequence/array' : typeof parsed
        }`,
      },
    };
  }

  const unknownKeys = Object.keys(parsed).filter(
    (k) => !(KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'unknown-key',
        message: `${file}: unrecognized top-level key(s): ${unknownKeys.join(', ')} — recognized keys are ${KNOWN_TOP_LEVEL_KEYS.join(', ')}`,
      },
    };
  }

  if (!('version' in parsed)) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'missing-version',
        message: `${file}: missing required 'version' key`,
      },
    };
  }

  if (parsed.version !== SUPPORTED_MANIFEST_VERSION) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'unrecognized-version',
        message: `${file}: unrecognized version ${JSON.stringify(parsed.version)} — this runner supports version ${SUPPORTED_MANIFEST_VERSION}`,
      },
    };
  }

  const shapeResult = ProjectManifestBodySchema.safeParse(parsed);
  if (!shapeResult.success) {
    return {
      kind: 'malformed',
      problem: {
        file,
        reason: 'invalid-shape',
        message: `${file}: ${shapeResult.error.message}`,
      },
    };
  }

  const manifest = shapeResult.data;
  const stepErrors: StepErrorsByExtensionPoint = {};

  const buildErr = validateSteps(file, 'build.before_pr', manifest.build?.before_pr, projectRoot, existsSync);
  if (buildErr) stepErrors['build.before_pr'] = buildErr;

  const releaseErr = validateSteps(
    file,
    'release.before_merge',
    manifest.release?.before_merge,
    projectRoot,
    existsSync,
  );
  if (releaseErr) stepErrors['release.before_merge'] = releaseErr;

  const verifyErr = validateSteps(file, 'verify.before_ack', manifest.verify?.before_ack, projectRoot, existsSync);
  if (verifyErr) stepErrors['verify.before_ack'] = verifyErr;

  return { kind: 'ok', file, manifest, stepErrors };
}

// --- accessors -------------------------------------------------------------------------------------

/** Everything the CLI runner (or any other consumer) needs to know about ONE extension point of a
 *  successfully-loaded (`kind: 'ok'`) manifest: either a scoped problem (run no steps, fail loud for
 *  THIS extension point only) or the ordered, clean step list (possibly empty — the "declares
 *  nothing for this gate" floor case). */
export type ExtensionPointResolution =
  | { outcome: 'blocked'; problem: ManifestProblem }
  | { outcome: 'steps'; steps: ManifestStep[] };

export function resolveExtensionPoint(
  result: Extract<ManifestLoadResult, { kind: 'ok' }>,
  extensionPoint: ExtensionPoint,
): ExtensionPointResolution {
  const problem = result.stepErrors[extensionPoint];
  if (problem) return { outcome: 'blocked', problem };

  const steps =
    extensionPoint === 'build.before_pr'
      ? result.manifest.build?.before_pr
      : extensionPoint === 'release.before_merge'
        ? result.manifest.release?.before_merge
        : result.manifest.verify?.before_ack;

  return { outcome: 'steps', steps: steps ?? [] };
}

/** The `preconditions` section, as pure DECLARED DATA — this function does nothing but read a
 *  string array off an already-parsed manifest. It is never invoked as a command, never passed to a
 *  shell, and no code path in this file (or src/cli/commands/gates.ts) ever executes a
 *  `preconditions` entry. See project-manifest.test.ts's dedicated safety test (a precondition
 *  string that reads like `"rm -rf /"`) for the executed proof. */
export function getPreconditions(manifest: ProjectManifest): string[] {
  return manifest.preconditions ?? [];
}
