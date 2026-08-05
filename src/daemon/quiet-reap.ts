// B-761: the ONE calm line the daemon's real runCommand implementation (src/bin/daemon.ts) renders
// for its quiet-mode reap call — used ONLY at the reap-before-adopt call site in scheduler.ts's
// handleWonTakeover. A reap racing a container that already exited (`docker rm -f` on a container
// that is already gone) is the ROUTINE case, not an error; raw Docker stderr there reads as scary
// when it is actually expected.
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
