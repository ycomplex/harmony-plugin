// B-1075: the ten-seam agent-adapter contract.
//
// An agent adapter describes, declaratively, how ONE coding-agent runtime (Claude Code today; Codex
// in B-1076) is installed, authenticated, invoked headless, resumed, instructed, given skills and
// MCP, fed its environment, what it can do, and what it reports back. Pure types + pure data: no
// adapter spawns anything. Since B-1077 container/provision.sh launches every leg through
// src/agents/registry.ts (`harmony agent argv` / `check-credentials`). The page is
// docs/agent-adapter-contract.md; the suite that checks an adapter is src/agents/conformance.ts.

import type { CostRegime, CredentialMode, RuntimeFamily } from './credentials.js';
import type { CapabilityClass } from './capabilities.js';

/** The ten seams, numbered. The order is the contract's; never reorder. */
export const SEAMS = [
  'launch', //        1. install / launch: which binary, how its presence is probed
  'auth', //          2. accepted credentials, their env vars, the derived cost regime
  'headless', //      3. headless invocation argv + exit semantics
  'session', //       4. session storage + resume
  'instructions', //  5. instruction-file rendering
  'skills', //        6. skill delivery
  'mcp', //           7. MCP rendering from one canonical connection definition
  'env', //           8. worker environment allowlist
  'capabilities', //  9. capability map
  'telemetry', //    10. telemetry: runtime, model, credential, cost regime (read by B-1078)
] as const;

export type SeamId = (typeof SEAMS)[number];

export const SEAM_NUMBER: Readonly<Record<SeamId, number>> = Object.fromEntries(
  SEAMS.map((s, i) => [s, i + 1]),
) as Record<SeamId, number>;

// --- 1. launch -----------------------------------------------------------------------------------
export interface LaunchSeam {
  /** The executable name resolved on PATH inside the worker image. */
  binary: string;
  /** argv that probes the binary is installed (exit 0 = present). */
  probeArgv: readonly string[];
}

// --- 2. auth -------------------------------------------------------------------------------------
export type CredentialResolution =
  | { ok: true; credential: CredentialMode }
  | { ok: false; error: string };

export interface AuthSeam {
  /** The credential modes this adapter accepts; all must be in its family's vocabulary. */
  acceptedCredentials: readonly CredentialMode[];
  /** The env var that carries each accepted credential. */
  credentialEnv: Readonly<Partial<Record<CredentialMode, string>>>;
  /** The preferred credential when the deployment does not say otherwise. */
  primaryCredential: CredentialMode;
  /** Resolve which credential an environment carries. Two at once is an error (no silent fallback);
   *  an empty value counts as unset. Never throws. */
  resolveCredential(env: Readonly<Record<string, string | undefined>>): CredentialResolution;
}

// --- 3. headless invocation ----------------------------------------------------------------------
export interface HeadlessInput {
  pluginDir: string;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  /** Upstream-supplied flags (provision.sh's CLAUDE_HEADLESS_FLAGS), passed through in order. */
  extraFlags?: readonly string[];
}

export interface ExitSemantics {
  /** Process exit code of a successful invocation. */
  successCode: number;
  /** A non-zero exit always fails the leg. */
  nonZeroIsFailure: true;
  /** The field in the structured result that marks an errored run despite exit 0, if any. */
  structuredErrorField: string | null;
}

export interface HeadlessSeam {
  /** Build the argv (excluding the binary) for one headless invocation. Pure. */
  buildArgv(input: HeadlessInput): string[];
  exit: ExitSemantics;
}

// --- 4. session storage + resume -----------------------------------------------------------------
export interface SessionSeam {
  /** Where session transcripts live, with `$HOME` left symbolic. */
  root: string;
  /** Transcript file extension, including the dot. */
  extension: string;
  /** The flag that resumes a session by id. */
  resumeFlag: string;
  /** The glob that locates the transcript for one session id. */
  sessionGlob(sessionId: string): string;
  /** The session id a transcript path names, or null when it is not a transcript path. */
  sessionIdFromPath(path: string): string | null;
}

// --- 5. instruction rendering --------------------------------------------------------------------
export interface InstructionsSeam {
  /** The project-level instruction file the runtime reads (a bare file name). */
  fileName: string;
  render(body: string): { fileName: string; content: string };
}

// --- 6. skill delivery ---------------------------------------------------------------------------
export interface AgentFileDelivery {
  /** Repo-relative source path. */
  source: string;
  /** Install target, with `$HOME` left symbolic. */
  target: string;
}

export interface SkillsSeam {
  /** How the plugin's skills reach the runtime (e.g. a CLI flag naming the plugin directory). */
  mechanism: string;
  /** The repo-relative directory the skills are read from. */
  skillsRoot: string;
  /** Extra agent-definition files copied into place before launch. */
  agentFiles: readonly AgentFileDelivery[];
}

// --- 7. MCP rendering ----------------------------------------------------------------------------
/** The ONE canonical definition of an MCP connection; each adapter renders it in its own format.
 *  `{pluginRoot}` in `args` is the placeholder for the plugin checkout's root. */
export interface McpConnection {
  name: string;
  command: string;
  args: readonly string[];
}

export const PLUGIN_ROOT_PLACEHOLDER = '{pluginRoot}';

/** The harmony MCP server, defined once. */
export const HARMONY_MCP_CONNECTION: McpConnection = {
  name: 'harmony',
  command: 'node',
  args: [`${PLUGIN_ROOT_PLACEHOLDER}/dist/index.js`],
};

export interface McpSeam {
  render(connection: McpConnection): { fileName: string; content: string };
}

// --- 8. worker environment allowlist -------------------------------------------------------------
export interface EnvSeam {
  /** The per-leg env vars the launch forwards into the worker, and no others. */
  allowlist: readonly string[];
  /** Standing secrets bound to the worker by a separate mechanism (never in the per-leg list). */
  standingSecrets: readonly string[];
}

// --- 9. capability map ---------------------------------------------------------------------------
export const CAPABILITIES = [
  'subagents',
  'hooks',
  'skills',
  'mcp',
  'resume',
  'modelSwitch',
  'structuredOutput',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySeam = Readonly<Record<Capability, boolean>>;

/** B-1150: how ONE skill's runtime-neutral capability classes (src/agents/capabilities.ts) land on this
 *  runtime. Part of seam 9 — the per-skill half of the capability map. */
export interface SkillCapabilityProjection {
  /** Frontmatter lines the runtime reads from SKILL.md, key → value (Claude: `allowed-tools`, and
   *  `disallowed-tools` when the skill forbids anything). Empty when the runtime reads none. */
  frontmatter: Readonly<Record<string, string>>;
  /** The session envelope that bounds the skill on this runtime, when it is not narrowed per skill
   *  (Codex: one bypass sandbox + approval-never envelope for every skill). Null = narrowed per skill. */
  envelope: string | null;
  /** The `forbid:` classes this runtime CANNOT enforce, each declared as a prose rule instead. */
  unenforcedForbids: readonly CapabilityClass[];
  /** One prose rule per unenforced forbid (same order). */
  proseRules: readonly string[];
}

export interface SkillCapabilitySeam {
  /** Project one skill's classes. Pure; throws on an unknown class. */
  project(skillName: string, classes: readonly CapabilityClass[]): SkillCapabilityProjection;
}

// --- 10. telemetry -------------------------------------------------------------------------------
export interface TelemetryContext {
  model: string | null;
  credential: CredentialMode;
}

export interface TelemetryRecord {
  runtime: string;
  model: string | null;
  credential: CredentialMode;
  costRegime: CostRegime;
  costUsd: number | null;
  sessionId: string | null;
  isError: boolean;
  /** B-1076: token usage, for an adapter whose capture is NOT the Claude result envelope (which
   *  `harmony leg-cost record` parses itself). Absent/null = not reported; each field is null when the
   *  runtime does not report it. */
  usage?: TelemetryUsage | null;
}

/** B-1076: the token counts a non-Claude runtime reports, in conduction_leg_costs' column vocabulary. */
export interface TelemetryUsage {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
}

export interface TelemetrySeam {
  /** Read one invocation's captured stdout. Null when it is not a result. Never throws. */
  parse(stdout: string, ctx: TelemetryContext): TelemetryRecord | null;
  /** A representative result, used by the conformance suite. */
  sampleOutput: string;
}

// --- the adapter ---------------------------------------------------------------------------------
export interface AgentAdapter {
  /** Registry id. */
  id: string;
  family: RuntimeFamily;
  displayName: string;
  launch: LaunchSeam;
  auth: AuthSeam;
  headless: HeadlessSeam;
  session: SessionSeam;
  instructions: InstructionsSeam;
  skills: SkillsSeam;
  mcp: McpSeam;
  env: EnvSeam;
  capabilities: CapabilitySeam;
  /** B-1150: seam 9's per-skill half — capability classes → this runtime. */
  skillCapabilities: SkillCapabilitySeam;
  telemetry: TelemetrySeam;
}
