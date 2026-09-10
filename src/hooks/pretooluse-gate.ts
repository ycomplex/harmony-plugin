// B-992: the interactive PRE-TOOL-USE GATE — the mechanical enforcement half of B-991's project
// manifest (`.harmony/project.yml`). Where the Stop hook (`stop-gate.ts`, B-870) stops a session
// from ENDING a turn with nothing on the board, this hook stops a POSITIVELY-IDENTIFIED daemon
// worker from USING a "boundary tool" — opening a PR, merging a PR, or accepting a verify brief —
// until the manifest's corresponding gate point has actually run for the current HEAD/conduction.
//
// It is the mirror image of the Stop gate in every structural respect (pure-core / thin-bin /
// sh-wrapper split, injected-deps testability, fail-open-on-everything discipline) but enforces the
// OPPOSITE direction, and — load-bearingly — gates a much NARROWER population: only an actor this
// hook can POSITIVELY identify as a daemon worker is ever denied (AC3). A human, or any session this
// hook cannot tell apart from a human, is NEVER denied, by construction — see `determineActor`.
//
// A project with no manifest, or a manifest that declares nothing for the point behind the tool
// being called, is a no-op — identical to today (the same floor B-991's own CLI runner holds).
//
// The gate runs as a Claude Code `PreToolUse` hook (`hooks/pretooluse-gate.sh` -> `dist/bin/
// pretooluse-gate.js`):
//
//   * denying a tool call is `exit 2` with the reason on stderr — the SAME mechanism the Stop hook
//     uses for its own block, per Claude Code's hook convention;
//   * every other outcome is exit 0.
//
// The fast path lives in the shell wrapper (three layers: no manifest -> exit 0 before node is ever
// considered; a manifest present but the raw stdin text does not even MENTION a boundary token
// (`gh pr create`, `gh pr merge`, `resolve_brief`) -> exit 0 without spawning node; node/dist
// missing -> exit 0). Nothing in THIS file runs for a call the wrapper's own grep has already ruled
// out.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getConductionId } from '../config/run-config.js';
import {
  PROJECT_MANIFEST_RELATIVE_PATH,
  resolveExtensionPoint,
  type ExtensionPoint,
  type ManifestLoadResult,
} from '../config/project-manifest.js';
import type { AuthenticatedContext } from '../cli/auth.js';

/** The operator's escape hatch. `<point>:<reason>` — matched against the extension point behind
 *  THIS call only; a call the escape hatch doesn't name falls through to ordinary evaluation. Its
 *  use is never silent: a visible ticket comment (or, failing that, a stderr line — see
 *  `postOverrideNotice`) always records it (AC5). */
export const GATE_OVERRIDE_ENV = 'HARMONY_GATE_OVERRIDE';

/** Where a successful `harmony gates run <point>` leaves its local evidence marker, gitignored —
 *  see project-manifest.ts's header for the convention this mirrors. */
export const GATE_EVIDENCE_DIR = '.harmony/.gate-evidence';

export function gateEvidenceMarkerPath(projectRoot: string, point: ExtensionPoint): string {
  return `${projectRoot}/${GATE_EVIDENCE_DIR}/${point}.json`;
}

/** The `PreToolUse` hook's stdin payload — the keys a LIVE capture confirmed the runtime sends (see
 *  `src/hooks/__fixtures__/pretooluse-*.json`). Deliberately permissive: only the fields this
 *  module actually reads are typed; everything else on the real payload (transcript_path, cwd,
 *  prompt_id, permission_mode, effort, tool_use_id, session_id) is ignored. */
export interface PreToolUseHookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** A TOTAL function over three real-world states, collapsed to the two that matter for this gate
 *  (AC3): `'worker'` is a session whose environment carries `HARMONY_CONDUCTION_ID` — written ONLY
 *  by the worker launch path (container/provision.sh), and unset in every human terminal or
 *  orchestrator session. `'human-or-ambiguous'` covers BOTH a positively-identified human AND any
 *  session this hook simply cannot tell apart from one — there is no third bucket, and only
 *  `'worker'` may ever be denied. Reuses `getConductionId` unchanged; this hook invents no second
 *  actor signal. */
export type Actor = 'worker' | 'human-or-ambiguous';

export function determineActor(env: NodeJS.ProcessEnv): Actor {
  return getConductionId(env) !== undefined ? 'worker' : 'human-or-ambiguous';
}

// --- boundary-tool matchers ----------------------------------------------------------------------

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;
const HELP_FLAG = /(--help\b|\s-h\b)/;
const REPO_FLAG = /(?:--repo|-R)[\s=]+("?)([^"\s]+)\1/;

/** The first `--repo <owner/name>` / `-R <owner/name>` value on a `gh` command line, or `null`. Not
 *  a real shell parse (no quoting beyond a single optional pair of double quotes) — this only ever
 *  decides whether the command names a DIFFERENT repo than the one this hook is running in. */
function extractRepoFlagValue(command: string): string | null {
  const match = command.match(REPO_FLAG);
  return match ? match[2] : null;
}

/** Does this Bash `command` string match a `gh pr <verb>` boundary tool call FOR THIS REPO?
 *  `--help`/`-h` never matches (AC: `gh pr create --help` must not gate). A `--repo`/`-R` value that
 *  names a DIFFERENT repo than `currentRepoSlug` never matches either — a PR opened elsewhere is not
 *  this project's gate to enforce. When `currentRepoSlug` itself could not be resolved, a command
 *  carrying an explicit `--repo` is treated as NOT this repo's boundary tool (fail-open: we cannot
 *  confirm sameness, so we do not gate on an unconfirmed guess). */
function matchesGhCommand(command: string, verb: RegExp, currentRepoSlug: string | null): boolean {
  if (!verb.test(command)) return false;
  if (HELP_FLAG.test(command)) return false;
  const repoFlag = extractRepoFlagValue(command);
  if (repoFlag) {
    if (!currentRepoSlug) return false;
    if (repoFlag.toLowerCase() !== currentRepoSlug.toLowerCase()) return false;
  }
  return true;
}

/** Which of the three fixed extension points (if any) this tool call is the boundary tool for. Pure
 *  over `(tool_name, tool_input)` plus the current repo slug (resolved by the caller, since deriving
 *  it is I/O — see `runPreToolUseGate`'s deps).
 *
 *  The `resolve_brief` matcher deliberately matches on a tool name ENDING in `resolve_brief`
 *  (`/resolve_brief$/`), never an exact match against a hardcoded prefix: a LIVE capture from a real
 *  conducted session showed the marketplace/installed-plugin loading path namespaces MCP tool names
 *  as `mcp__plugin_harmony-plugin_harmony__resolve_brief` — not the bare `mcp__harmony__resolve_brief`
 *  a raw `.mcp.json` server key would produce. Matching on the suffix works under either mechanism. */
export function matchBoundaryTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  currentRepoSlug: string | null,
): ExtensionPoint | null {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (matchesGhCommand(command, GH_PR_CREATE, currentRepoSlug)) return 'build.before_pr';
    if (matchesGhCommand(command, GH_PR_MERGE, currentRepoSlug)) return 'release.before_merge';
    return null;
  }
  if (/resolve_brief$/.test(toolName) && toolInput.command === 'accept') {
    return 'verify.before_ack';
  }
  return null;
}

// --- the local evidence marker: freshness -------------------------------------------------------

/** What `harmony gates run <point>` (src/cli/commands/gates.ts) writes locally, atomically, after a
 *  fully successful run — column-for-column what this hook reads back. Gitignored
 *  (`.harmony/.gate-evidence/`); never committed. */
export interface GateEvidenceMarker {
  extension_point: ExtensionPoint;
  /** `getConductionId(env) ?? 'none'` at write time. */
  conduction_id: string;
  /** `git rev-parse HEAD` in the project root at write time. */
  head_sha: string;
  ran_at: string;
  /** Mirrors gates.ts's own landEvidence outcome — true on success, false on its existing
   *  WARNING-path failure. Informational only; freshness never depends on it. */
  evidence_landed: boolean;
}

export type MarkerFreshness = 'absent' | 'stale' | 'fresh';

/** A marker is `'fresh'` only when it was written for the EXACT HEAD this call is running against,
 *  and — for a worker actor — the EXACT conduction this leg belongs to (a different leg's marker
 *  must never wave THIS leg's boundary call through). `null` is `'absent'`; a HEAD mismatch (a stale
 *  run, or a different worktree) is `'stale'`; both are "not yet run" for the deny decision. */
export function readMarkerFreshness(
  marker: GateEvidenceMarker | null,
  currentHeadSha: string,
  currentConductionId: string | undefined,
): MarkerFreshness {
  if (!marker) return 'absent';
  if (marker.head_sha !== currentHeadSha) return 'stale';
  if (marker.conduction_id !== (currentConductionId ?? 'none')) return 'stale';
  return 'fresh';
}

// --- the escape hatch -----------------------------------------------------------------------------

export interface GateOverride {
  point: string;
  reason: string;
}

/** `HARMONY_GATE_OVERRIDE=<point>:<reason>` — split on the FIRST colon; `reason` may itself contain
 *  colons. `undefined`/no-colon/blank-point/blank-reason all parse to `null` (nothing to apply). */
export function parseGateOverride(raw: string | undefined): GateOverride | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx === -1) return null;
  const point = raw.slice(0, idx).trim();
  const reason = raw.slice(idx + 1).trim();
  if (!point || !reason) return null;
  return { point, reason };
}

function overrideNotice(point: ExtensionPoint, reason: string): string {
  return `⚠ Gate override used — ${point} was bypassed. Reason: ${reason}.`;
}

// --- the decision, and everything it needs -------------------------------------------------------

export type GateDecision = { action: 'allow'; reason: string } | { action: 'deny'; message: string };

/** Everything `decidePreToolUseGate` touches outside itself, injected so the whole decision tree is
 *  unit-testable without a real filesystem, git, network, or subprocess. Mirrors
 *  `GatesRunDeps` (src/cli/commands/gates.ts) and `StopGateDeps` (src/hooks/stop-gate.ts). */
export interface PreToolUseGateDeps {
  env: NodeJS.ProcessEnv;
  /** The repo root the manifest is resolved relative to — production always passes the hook's cwd. */
  projectRoot: string;
  loadManifest: (projectRoot: string) => ManifestLoadResult;
  /** `owner/name` of THIS repo's `git remote get-url origin`, or `null` when it could not be
   *  resolved/parsed. MAY throw — the caller treats any throw as `null`. */
  resolveCurrentRepoSlug: () => string | null;
  /** `git rev-parse HEAD` in `projectRoot`. MAY throw — the caller treats any throw as `''`, which
   *  can never match a written marker's `head_sha`, so the marker reads as stale (safe: it degrades
   *  toward the confirm/deny path, and the confirm step itself still fails open). */
  resolveHeadSha: () => string;
  /** Reads and parses this extension point's local marker, or `null` if absent. MAY throw — the
   *  caller treats any throw as `null` (absent). */
  readMarker: (point: ExtensionPoint) => GateEvidenceMarker | null;
  /** The verify.before_ack CONFIRM step (see the big comment on `decidePreToolUseGate` below): reads
   *  the task's CURRENT `awaiting_human_reason` via `harmony --json tasks get <task_id>`. MAY
   *  throw/reject/time out — the caller treats that as "cannot confirm" and fails open (allow). */
  queryAwaitingReason: (taskId: string) => Promise<string | null>;
  /** Acquires the authenticated context, for the escape hatch's comment-posting path only. MAY
   *  throw/reject. */
  getAuthenticatedContext: () => Promise<AuthenticatedContext>;
  /** Resolves a conduction id to its owning task id, or `null`. Production reuses B-916's
   *  `resolveLegCostContext` verbatim, exactly like gates.ts's own `landEvidence` resolution. */
  resolveTaskId: (client: SupabaseClient, conductionId: string) => Promise<string | null>;
  addComment: (
    client: SupabaseClient,
    projectId: string,
    userId: string,
    taskId: string,
    content: string,
  ) => Promise<void>;
  /** stderr — both the deny message and the override's stderr fallback go here. */
  log: (line: string) => void;
}

/** The escape hatch's notice: a visible ticket comment when a task id can be resolved, a stderr
 *  line when it cannot — NEVER silent, NEVER a crash (any throw anywhere in this function degrades
 *  to the stderr fallback).
 *
 *  Task id resolution differs by matcher: the verify accept's OWN `tool_input.task_id` is already
 *  available directly; the Bash (build/release) matchers have no task id on the call at all, so it
 *  is resolved the same way gates.ts's own `landEvidence` does — `getConductionId` ->
 *  `resolveLegCostContext` (which needs an authenticated client first). */
async function postOverrideNotice(
  point: ExtensionPoint,
  reason: string,
  toolInput: Record<string, unknown>,
  deps: PreToolUseGateDeps,
): Promise<void> {
  const notice = overrideNotice(point, reason);
  try {
    if (point === 'verify.before_ack' && typeof toolInput.task_id === 'string' && toolInput.task_id) {
      const ctx = await deps.getAuthenticatedContext();
      await deps.addComment(ctx.client, ctx.projectId, ctx.userId, toolInput.task_id, notice);
      return;
    }

    const conductionId = getConductionId(deps.env);
    if (!conductionId) {
      deps.log(notice);
      return;
    }
    const ctx = await deps.getAuthenticatedContext();
    const taskId = await deps.resolveTaskId(ctx.client, conductionId);
    if (!taskId) {
      deps.log(notice);
      return;
    }
    await deps.addComment(ctx.client, ctx.projectId, ctx.userId, taskId, notice);
  } catch {
    deps.log(notice);
  }
}

function denyMessage(point: ExtensionPoint): string {
  return (
    `[harmony pretooluse-gate] BLOCKED — ${point} has not run for this HEAD/conduction yet. Run ` +
    `\`harmony gates run ${point}\` first (see ${PROJECT_MANIFEST_RELATIVE_PATH}). If this is ` +
    `deliberate, set ${GATE_OVERRIDE_ENV}=${point}:<reason> and retry — the override is logged as a ` +
    `visible ticket comment.`
  );
}

/** The whole decision, dependency-injected but otherwise pure — no hidden globals, every I/O op goes
 *  through `deps`. Mirrors `runGatesCommand`'s own DI-testable-async convention.
 *
 *  === THE verify.before_ack AMBIGUITY (read before touching this function) ===
 *
 *  `resolve_brief`+`accept` is the SAME tool call for FIVE different gate reasons: clarify,
 *  decompose, design, plan, and verify — plus release's OWN accept
 *  (`release-decision-pending`), which this extension point must NEVER deny (its own boundary tool
 *  is the `gh pr merge` Bash call above; `release-decision-pending`'s accept carries
 *  `pending_activity: null` and is not itself a boundary tool). `resolve_brief`'s input schema is
 *  just `{task_id, command, detail?, remark?, provenance}` — no field says WHICH gate's accept this
 *  is — so the hook cannot tell from `tool_input` alone.
 *
 *  A false-positive DENY here would wedge the WHOLE conductor loop (a worker blocked from ever
 *  accepting a clarify/design/plan/release brief) — a far worse failure than under-blocking one
 *  missed verify ack. So this is the ONE matcher with an extra confirm step, and it is
 *  deliberately LOCAL-FIRST: the common case (marker fresh, or no marker and the call turns out not
 *  to be the verify accept) costs zero or one cheap local reads; a NETWORK read only happens
 *  immediately before an actual DENY would otherwise be returned — the exact latency shape the
 *  ratified design chose local-first evidence checking to protect (a rare, already-slower-than-a-
 *  Bash-call path, not the routine one). Concretely:
 *
 *   1. LOCAL marker fresh -> ALLOW, zero network, done (the common path for a verify accept that
 *      really did run the gate).
 *   2. Marker absent/stale -> this MIGHT be the verify accept or might be an unrelated accept.
 *      Do NOT deny yet: read `tool_input.task_id` (always present on resolve_brief) and shell out
 *      (via `deps.queryAwaitingReason`, timeout-bounded by the bin's real implementation, mirroring
 *      stop-gate.ts's `queryRow`/`CLI_TIMEOUT_MS`) to the task's CURRENT `awaiting_human_reason`.
 *        - not `'verification-ack-pending'` -> ALLOW (this accept isn't the verify boundary tool).
 *        - IS `'verification-ack-pending'` -> DENY (exactly the case AC1/AC3 exist to catch).
 *        - the confirm read throws/times out/is unparseable -> ALLOW (fail-open; a confirmation
 *          failure must never become a wrongful deny OR a wrongful indefinite wedge). */
export async function decidePreToolUseGate(
  payload: PreToolUseHookInput,
  deps: PreToolUseGateDeps,
): Promise<GateDecision> {
  const toolName = payload.tool_name ?? '';
  const toolInput = payload.tool_input ?? {};

  let currentRepoSlug: string | null;
  try {
    currentRepoSlug = deps.resolveCurrentRepoSlug();
  } catch {
    currentRepoSlug = null;
  }

  const point = matchBoundaryTool(toolName, toolInput, currentRepoSlug);
  if (!point) {
    return { action: 'allow', reason: 'not a boundary-tool call for any declared extension point' };
  }

  if (determineActor(deps.env) !== 'worker') {
    return { action: 'allow', reason: 'actor is human-or-ambiguous — never denied (AC3)' };
  }

  const manifestResult = deps.loadManifest(deps.projectRoot);
  if (manifestResult.kind !== 'ok') {
    return {
      action: 'allow',
      reason: `no usable ${PROJECT_MANIFEST_RELATIVE_PATH} (${manifestResult.kind}) — no-op floor`,
    };
  }

  const resolution = resolveExtensionPoint(manifestResult, point);
  if (resolution.outcome === 'blocked') {
    return { action: 'allow', reason: `${point}: manifest problem scoped to this point — fail open` };
  }
  if (resolution.steps.length === 0) {
    return { action: 'allow', reason: `${point}: manifest declares nothing for this point — no-op floor` };
  }

  // --- the escape hatch, checked EARLY (before marker/confirm logic) for a call that HAS matched. -
  const override = parseGateOverride(deps.env[GATE_OVERRIDE_ENV]);
  if (override && override.point === point) {
    await postOverrideNotice(point, override.reason, toolInput, deps);
    return { action: 'allow', reason: `${point}: gate override used` };
  }

  // --- local-first evidence check -----------------------------------------------------------------
  let headSha = '';
  try {
    headSha = deps.resolveHeadSha();
  } catch {
    /* an unresolvable HEAD can never match a written marker's head_sha — degrades to stale. */
  }
  const conductionId = getConductionId(deps.env);

  let marker: GateEvidenceMarker | null = null;
  try {
    marker = deps.readMarker(point);
  } catch {
    /* an unreadable/absent marker reads as absent. */
  }
  const freshness = readMarkerFreshness(marker, headSha, conductionId);

  if (freshness === 'fresh') {
    return { action: 'allow', reason: `${point}: local evidence marker is fresh` };
  }

  if (point !== 'verify.before_ack') {
    return { action: 'deny', message: denyMessage(point) };
  }

  // --- verify.before_ack's confirm-before-deny step — see the big comment above. -------------------
  const taskId = typeof toolInput.task_id === 'string' ? toolInput.task_id : '';
  if (!taskId) {
    return { action: 'allow', reason: 'verify.before_ack: no task_id on the call to confirm against — fail open' };
  }

  let awaitingReason: string | null;
  try {
    awaitingReason = await deps.queryAwaitingReason(taskId);
  } catch {
    return { action: 'allow', reason: 'verify.before_ack: confirm read failed — fail open' };
  }

  if (awaitingReason !== 'verification-ack-pending') {
    return { action: 'allow', reason: 'verify.before_ack: confirmed this accept is not the verify gate' };
  }

  return { action: 'deny', message: denyMessage(point) };
}

/** Everything the runner touches outside `decidePreToolUseGate` — the raw stdin payload. */
export interface PreToolUseGateRunnerDeps extends PreToolUseGateDeps {
  /** The raw stdin payload. */
  input: string;
}

/** Runs the gate and returns the PROCESS EXIT CODE: 2 denies the tool call, 0 allows it. Every
 *  failure mode — malformed stdin JSON, anything `decidePreToolUseGate` itself didn't already
 *  catch — degrades to `return 0` (allow), mirroring `runStopGate`'s outer fail-open try/catch. */
export async function runPreToolUseGate(deps: PreToolUseGateRunnerDeps): Promise<number> {
  try {
    const payload = JSON.parse(deps.input) as PreToolUseHookInput;
    const decision = await decidePreToolUseGate(payload, deps);
    if (decision.action === 'deny') {
      deps.log(decision.message);
      return 2;
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.log(`[harmony pretooluse-gate] could not run (${message}) — allowing (fail-open).`);
    } catch {
      /* even logging is best-effort */
    }
    return 0;
  }
}

/** Pure parse of a `git remote get-url origin`-style URL into `owner/name`, or `null` if it doesn't
 *  look like one. Exported so both the real bin (which shells out to git) and tests can exercise the
 *  parsing in isolation from any subprocess. */
export function parseOwnerRepoSlug(url: string): string | null {
  const match = url.trim().match(/[/:]([^/:]+)\/([^/]+?)(\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
