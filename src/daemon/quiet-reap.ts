// B-761: the ONE calm line a quiet runCommand call renders when its CALLER supplies this as its
// `quietRender` — used explicitly by scheduler.ts's handleWonTakeover reap-before-adopt call site
// (`quietRender: renderQuietReapOutcome`). A reap racing a container that already exited (`docker rm
// -f` on a container that is already gone) is the ROUTINE case, not an error; raw Docker stderr there
// reads as scary when it is actually expected.
//
// B-740 REOPEN FIX: `{ quiet: true }` ALONE (no `quietRender`) now means "suppress raw stdout/
// stderr, but log NOTHING on success" — src/daemon/preflight.ts's boot tool-check (`command -v
// <tool>`) has its OWN quiet path and no longer goes through this renderer AT ALL. It used to
// (implicitly — the old two-way `quiet` flag had no separate renderer knob, so `runCommand`'s close
// handler called this renderer unconditionally whenever `quiet` was set), which is exactly how a
// passing `command -v <tool>` on EVERY boot logged "reaped a live worker" regardless of whether
// anything was actually running or reaped. See `quietLogLine` below (the decision daemon.ts's
// runCommand closure now delegates to) and quiet-reap.test.ts for the fix's regression coverage.
//
// Pulled into its own module (rather than living inline in src/bin/daemon.ts) so it is unit-testable
// without importing the entrypoint file itself — daemon.ts calls `main()` at module scope, so
// importing it directly from a test would run the real daemon.

/** Keyed ONLY on the exit code — never parses stdout/stderr content (the agent-portability "worker
 *  output is never parsed" guardrail extends to never even SHOWING it for this one call site).
 *
 *  B-761 reopen fix: the reap scripts (container/cloud-worker-reap.sh, container/docker-worker-
 *  reap.sh) used to always exit 0 regardless of whether anything was actually found+reaped, which
 *  made this renderer's original two-way exitCode===0/else split silently invert — every reap,
 *  live-kill or routine-miss alike, rendered as "reaped a live container". Both scripts now use a
 *  real three-way exit-code contract (0 = a live worker was found and reaped, 3 = the routine
 *  miss — nothing was there, other = a genuine unexpected error), and this renderer follows suit. */
export function renderQuietReapOutcome(exitCode: number | null): string {
  if (exitCode === 0) return 'reaped a live worker';
  if (exitCode === 3) return 'reap: worker already gone — ok';
  return `reap: unexpected exit code ${exitCode === null ? 'null' : exitCode} — investigate`;
}

/** B-740: decide the ONE line (if any) a quiet runCommand call should log on close, given the two
 *  independent opts a caller can supply — extracted so src/bin/daemon.ts's runCommand closure
 *  (untestable directly: daemon.ts calls `main()` at module scope) can have this exact decision
 *  proven correct without importing the entrypoint.
 *
 *  `{ quiet: true }` ALONE (no `quietRender`) renders NOTHING — this is the regression this function
 *  guards: src/daemon/preflight.ts's boot tool-check passes exactly this shape on every `command -v
 *  <tool>` resolution, and a passing check must never look like a reap outcome. Only a caller that
 *  ALSO supplies `quietRender` (today, only scheduler.ts's handleWonTakeover reap-before-adopt call
 *  site, via `quietRender: renderQuietReapOutcome`) gets that renderer's line. `quiet: false`/absent
 *  also renders nothing here — that path streams raw stdout/stderr instead (see daemon.ts). */
export function quietLogLine(
  exitCode: number | null,
  opts?: { quiet?: boolean; quietRender?: (code: number | null) => string },
): string | null {
  if (!opts?.quiet || !opts.quietRender) return null;
  return opts.quietRender(exitCode);
}
