// B-991: `harmony gates run <extension-point>` — the CLI runner for a project's `.harmony/
// project.yml` gate manifest (src/config/project-manifest.ts). Consulted by start-work (AC2, before
// a delegated build begins in its isolated worktree) and by finish-work's release-prep step (AC3),
// in place of hand-copied CLAUDE.md prose.
//
// THE FLOOR (AC4) IS THE WHOLE POINT: a project with no manifest, or one that declares nothing for
// the requested extension point, must behave IDENTICALLY to today — meaning, concretely, exit 0
// with one quiet stdout line and ZERO network activity. That second half is why this file is split
// into a pure, dependency-injected core (`runGatesCommand`, unit-tested in gates.test.ts without
// touching a real filesystem/network/subprocess) and a thin CLI wrapper (`registerGatesCommands`)
// that supplies the real filesystem/subprocess/auth/DB — mirrors src/hooks/stop-gate.ts's own
// pure-core-plus-thin-I/O-shell split, for the same testability reason.
//
// THE ORDERING CONSTRAINT THAT MAKES THE FLOOR HOLD: the manifest is located and parsed FIRST,
// entirely offline. Only once there is at least one step to actually execute (and therefore
// evidence to land on the ticket) does this command call `getAuthenticatedContext` — never before.
// A malformed manifest (AC5) fails loud (non-zero exit, names the file + the specific problem) but
// STILL never authenticates and still runs no steps for the extension point(s) that manifest would
// have declared; it never silently falls back to the floor, and a problem scoped to one extension
// point (a missing script, an `agent_task:` step — see project-manifest.ts's per-extension-point
// `stepErrors`) never blocks any OTHER extension point's own invocation.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EXTENSION_POINTS,
  PROJECT_MANIFEST_RELATIVE_PATH,
  getPreconditions,
  isRunStep,
  loadProjectManifest,
  resolveExtensionPoint,
  type ExtensionPoint,
  type ManifestLoadResult,
  type ManifestStep,
} from '../../config/project-manifest.js';
import { getConductionId } from '../../config/run-config.js';
import { resolveLegCostContext } from '../../tools/leg-cost-record.js';
import { manageTestCases } from '../../tools/test-cases.js';
import { gateEvidenceMarkerPath, type GateEvidenceMarker } from '../../hooks/pretooluse-gate.js';
import { getAuthenticatedContext, type AuthenticatedContext } from '../auth.js';

/** One `run:` step's execution outcome — `code` is the subprocess's real exit code (`null` only
 *  when the process could not be spawned/signalled at all, in which case `error` is set). */
export interface StepRunOutcome {
  code: number | null;
  error?: Error;
}

/** Everything `runGatesCommand` touches outside itself — injected so the whole decision tree
 *  (no-op floor, malformed handling, step execution, evidence landing) is unit-testable without a
 *  real filesystem, subprocess, or network call. Mirrors StopGateDeps's (src/hooks/stop-gate.ts)
 *  convention: production wiring lives ONLY in `registerGatesCommands` below. */
export interface GatesRunDeps {
  /** The repo root the manifest is resolved relative to — production always passes `process.cwd()`. */
  projectRoot: string;
  /** The raw CLI argument, validated against EXTENSION_POINTS inside the function (not by the
   *  caller) so an unrecognized value is a clean, tested error path rather than a thrown TypeError. */
  extensionPoint: string;
  loadManifest: (projectRoot: string) => ManifestLoadResult;
  /** Executes ONE `run:` step's command as a subprocess. NEVER called for a manifest resolved as
   *  absent/empty/malformed/blocked — only once there is a real step to run. */
  runStep: (command: string, cwd: string) => StepRunOutcome;
  /** Acquires the authenticated context. Called AT MOST ONCE, and ONLY when at least one step is
   *  about to execute — see this file's header. May throw/reject; a failure degrades to "steps still
   *  run, but no evidence lands" rather than aborting the gate (mirrors this repo's other worker-side
   *  accessors' own "auth is best-effort, execution is not" posture — src/cli/commands/leg-cost.ts,
   *  leg-output.ts). */
  getAuthenticatedContext: () => Promise<AuthenticatedContext>;
  /** This leg's conduction id, if any (production: src/config/run-config.ts's getConductionId). */
  getConductionId: () => string | undefined;
  /** Resolves the ticket (task) id this conduction belongs to, or `null` when it cannot be
   *  determined — production reuses B-916's resolveLegCostContext verbatim (same denormalized
   *  conduction -> task_id read every other worker-side accessor in this repo already uses). */
  resolveTaskId: (client: SupabaseClient, conductionId: string) => Promise<string | null>;
  /** Lands ONE evidence entry after a fully-successful run. Production types it `integration`
   *  (AC8's explicit, deliberate choice) via manage_test_cases. */
  landEvidence: (
    ctx: AuthenticatedContext,
    taskId: string,
    extensionPoint: ExtensionPoint,
    stepCount: number,
  ) => Promise<void>;
  /** B-992: writes the local gate-evidence marker for THIS extension point — best-effort, atomic
   *  (write-temp-then-rename in production). MAY throw; a throw degrades to a WARNING, never a
   *  failed command, mirroring `landEvidence`'s own best-effort discipline. Read back by the
   *  PreToolUse hook (src/hooks/pretooluse-gate.ts) as its local-first evidence check. */
  writeMarker: (marker: GateEvidenceMarker) => void;
  /** `git rev-parse HEAD` in `projectRoot`, stamped onto the marker. Production wiring only; MAY
   *  throw (a throw degrades the marker write to the same best-effort WARNING as above). */
  resolveHeadSha: () => string;
  log: (line: string) => void;
  error: (line: string) => void;
}

function stepCommand(step: ManifestStep): string {
  return isRunStep(step) ? step.run : '';
}

/** The whole decision tree, pure I/O aside from its injected deps. Returns the PROCESS EXIT CODE:
 *  0 on a no-op floor or a fully successful run, non-zero on any malformed/blocked/failed outcome. */
export async function runGatesCommand(deps: GatesRunDeps): Promise<number> {
  const { projectRoot, log, error } = deps;

  if (!(EXTENSION_POINTS as readonly string[]).includes(deps.extensionPoint)) {
    error(
      `harmony gates run: unrecognized extension point '${deps.extensionPoint}' — expected one of: ${EXTENSION_POINTS.join(', ')}`,
    );
    return 1;
  }
  const extensionPoint = deps.extensionPoint as ExtensionPoint;

  // --- locate + parse the manifest FIRST, entirely offline. -------------------------------------
  const result = deps.loadManifest(projectRoot);

  if (result.kind === 'absent') {
    log(
      `harmony gates run ${extensionPoint}: no ${PROJECT_MANIFEST_RELATIVE_PATH} in ${projectRoot} — ` +
        'nothing declared; behavior is unchanged from today.',
    );
    return 0;
  }

  if (result.kind === 'malformed') {
    error(`harmony gates run ${extensionPoint}: MALFORMED manifest — ${result.problem.message}`);
    return 1;
  }

  const resolution = resolveExtensionPoint(result, extensionPoint);
  if (resolution.outcome === 'blocked') {
    error(`harmony gates run ${extensionPoint}: MALFORMED — ${resolution.problem.message}`);
    return 1;
  }

  // build.before_pr prints the manifest's declared preconditions — DATA ONLY, never executed (see
  // project-manifest.ts's own header + its dedicated safety test) — REGARDLESS of whether this
  // extension point declares any run: steps. Declared data prints whenever present; step-running is
  // a separate concern below.
  //
  // B-992 fix: this block used to sit AFTER the `steps.length === 0` early return below, so a
  // manifest declaring top-level `preconditions` but ZERO `build.before_pr` steps never printed
  // them — confirmed live on this repo's own manifest (preconditions declared, no build.before_pr
  // steps): `harmony gates run build.before_pr` printed only the no-op line, never the 5
  // preconditions. Hoisted here so it always fires for build.before_pr on any successfully-parsed
  // manifest; the steps.length === 0 check right below still governs step EXECUTION.
  if (extensionPoint === 'build.before_pr') {
    const preconditions = getPreconditions(result.manifest);
    if (preconditions.length > 0) {
      log(`harmony gates run ${extensionPoint}: declared preconditions (${result.file}, never executed):`);
      for (const item of preconditions) log(`  - ${item}`);
    } else {
      log(`harmony gates run ${extensionPoint}: ${result.file} declares no preconditions.`);
    }
  }

  const steps = resolution.steps;
  if (steps.length === 0) {
    log(
      `harmony gates run ${extensionPoint}: ${result.file} declares nothing for this extension point — ` +
        'nothing to do; behavior is unchanged from today.',
    );
    return 0;
  }

  // --- ONLY NOW, with at least one real step to run, acquire the authenticated context. ----------
  let ctx: AuthenticatedContext | null = null;
  try {
    ctx = await deps.getAuthenticatedContext();
  } catch (err: unknown) {
    error(
      `harmony gates run ${extensionPoint}: WARNING — could not authenticate ` +
        `(${(err as { message?: string })?.message ?? String(err)}); steps will still run, but no ` +
        'evidence will be landed on the ticket.',
    );
  }

  for (let i = 0; i < steps.length; i++) {
    const command = stepCommand(steps[i]);
    log(`harmony gates run ${extensionPoint}: [${i + 1}/${steps.length}] running: ${command}`);
    const outcome = deps.runStep(command, projectRoot);
    if (outcome.error || outcome.code !== 0) {
      error(
        `harmony gates run ${extensionPoint}: step ${i + 1}/${steps.length} FAILED ('${command}') — ` +
          (outcome.error ? outcome.error.message : `exit code ${outcome.code}`),
      );
      return outcome.error || !outcome.code ? 1 : outcome.code;
    }
  }

  log(`harmony gates run ${extensionPoint}: all ${steps.length} step(s) passed.`);

  // --- evidence landing: only after a fully successful run, only when auth + conduction/task ------
  // context all resolved. Best-effort — never turns a successful run into a failed command.
  let evidenceLanded = false;
  if (ctx) {
    const conductionId = deps.getConductionId();
    const taskId = conductionId ? await deps.resolveTaskId(ctx.client, conductionId) : null;
    if (taskId) {
      try {
        await deps.landEvidence(ctx, taskId, extensionPoint, steps.length);
        log(`harmony gates run ${extensionPoint}: landed 1 integration test-case entry on the ticket.`);
        evidenceLanded = true;
      } catch (err: unknown) {
        error(
          `harmony gates run ${extensionPoint}: WARNING — could not land evidence on the ticket ` +
            `(${(err as { message?: string })?.message ?? String(err)}).`,
        );
      }
    } else {
      error(
        `harmony gates run ${extensionPoint}: no conduction/task context available — evidence not landed.`,
      );
    }
  }

  // B-992: the local gate-evidence marker — lets the PreToolUse hook (src/hooks/pretooluse-gate.ts)
  // confirm this extension point ran for the CURRENT HEAD/conduction without a network read on its
  // common path. Best-effort, same WARNING-and-continue discipline as evidence landing above; never
  // affects the exit code.
  try {
    deps.writeMarker({
      extension_point: extensionPoint,
      conduction_id: deps.getConductionId() ?? 'none',
      head_sha: deps.resolveHeadSha(),
      ran_at: new Date().toISOString(),
      evidence_landed: evidenceLanded,
    });
  } catch (err: unknown) {
    error(
      `harmony gates run ${extensionPoint}: WARNING — could not write the local gate-evidence marker ` +
        `(${(err as { message?: string })?.message ?? String(err)}).`,
    );
  }

  return 0;
}

export function registerGatesCommands(program: Command): void {
  const gates = program
    .command('gates')
    .description(
      "B-991 project gate manifest runner — reads a project's .harmony/project.yml and runs the " +
        'declared steps for one extension point. Absent/empty manifest is a no-op floor identical ' +
        "to today's behavior (see this file's header).",
    );

  gates
    .command('run')
    .description(
      'Run the declared run: steps for <extension-point> (build.before_pr | release.before_merge | ' +
        'verify.before_ack). Exits 0 with no network call when the manifest is absent or declares ' +
        'nothing for this extension point; exits non-zero and names the problem on a malformed ' +
        'manifest or an unsupported step (agent_task:); exits non-zero naming the failing step on a ' +
        'failed run: step.',
    )
    .argument('<extension-point>', 'build.before_pr | release.before_merge | verify.before_ack')
    .action(async (extensionPoint: string) => {
      const exitCode = await runGatesCommand({
        projectRoot: process.cwd(),
        extensionPoint,
        loadManifest: loadProjectManifest,
        runStep: (command, cwd) => {
          const result = spawnSync(command, { shell: true, stdio: 'inherit', cwd });
          return { code: result.status, error: result.error };
        },
        getAuthenticatedContext,
        getConductionId: () => getConductionId(),
        resolveTaskId: async (client, conductionId) => {
          const context = await resolveLegCostContext(client, conductionId);
          return context?.task_id ?? null;
        },
        landEvidence: async (ctx, taskId, point, stepCount) => {
          await manageTestCases(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            add: [
              {
                name: `harmony gates run ${point}: ${stepCount} step(s) passed`,
                type: 'integration',
              },
            ],
          });
        },
        writeMarker: (marker) => writeGateEvidenceMarker(process.cwd(), marker),
        resolveHeadSha: () =>
          execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
        log: (line) => console.log(line),
        error: (line) => console.error(line),
      });
      process.exit(exitCode);
    });
}

/** B-992: the real, atomic (write-temp-then-rename) marker write — production-only I/O, kept out of
 *  `runGatesCommand` so the pure core stays testable without touching a real filesystem. Read back
 *  by src/hooks/pretooluse-gate.ts via `gateEvidenceMarkerPath`. */
function writeGateEvidenceMarker(projectRoot: string, marker: GateEvidenceMarker): void {
  const filePath = gateEvidenceMarkerPath(projectRoot, marker.extension_point);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}
