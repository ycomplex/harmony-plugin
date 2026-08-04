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
 *  output is never parsed" guardrail extends to never even SHOWING it for this one call site). */
export function renderQuietReapOutcome(exitCode: number | null): string {
  return exitCode === 0 ? 'reaped a live container' : 'reap: container already gone — ok';
}
