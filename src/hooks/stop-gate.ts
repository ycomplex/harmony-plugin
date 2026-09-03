// B-870: the interactive STOP GATE — the mechanical half of the clean-exit contract.
//
// A conducted / ticket-driving Claude Code session must not be able to voluntarily end its turn
// with NOTHING on the Harmony board. `skills/harmony-shared/clean-exit-contract.md` states the rule
// and the daemon's `src/daemon/classify.ts` enforces it for one-shot workers; until this module the
// interactive side was prose discipline only, and an audit showed prose alone does not hold.
//
// The gate runs as a Claude Code `Stop` hook (`hooks/stop-gate.sh` → `dist/bin/stop-gate.js`):
//
//   * blocking a turn-end is `exit 2` with the reason on stderr — the reason reaches the model and
//     it acts on it (live-smoked);
//   * a stop that FOLLOWS a block arrives with `stop_hook_active: true` — the runtime's own
//     re-entry signal, and what this module keys its block cap on;
//   * every other outcome is exit 0.
//
// Three properties are load-bearing and are pinned by tests:
//
//   1. FAIL OPEN on anything unexpected (AC8). A malformed payload, an unreadable breadcrumb, a CLI
//      failure, a timeout, a network error — the stop is ALLOWED. A broken gate must never be able
//      to trap a human in a terminal.
//   2. NEVER WEDGE (AC6). The cap is `MAX_BLOCKS_PER_TURN_END`; past it the gate degrades to a loud
//      stderr line naming the row state it could not classify, and lets the stop through.
//   3. ONE clean list (AC7). "Clean" is `isCleanRowShape` from the daemon's classifier — imported,
//      never re-stated here. `stop-gate.contract.test.ts` fails if the two ever disagree.
//
// The fast path (AC9 — a session with no conduct breadcrumb ends its turn with no measurable delay
// and no network call) is NOT here: it is a `test -f` in the shell wrapper, which exits 0 before
// node is ever spawned. Nothing in this file runs for a non-conducting session.

import { isCleanRowShape, type CleanRowShape } from '../daemon/classify.js';

/** The operator's escape switch. A HUMAN-ONLY control: set it in your own shell profile to run a
 *  session without the gate. It is deliberately absent from every daemon/container profile in this
 *  repo (`stop-gate.contract.test.ts` asserts that), so a daemon worker can never be started with
 *  the gate silently off. Its use is always logged (AC3). */
export const STOP_GATE_ESCAPE_ENV = 'HARMONY_STOP_GATE_OFF';

/** How many times the gate may block ONE turn-end before it degrades and lets the stop through
 *  (AC6: "blocks the same turn-end twice in a row, the third attempt is allowed through").
 *
 *  The native re-entry signal is `stop_hook_active` — true on any stop that follows a block, false
 *  on a fresh turn-end — and it is what RESETS the count: a stop arriving with the flag false is a
 *  brand-new turn-end, so whatever a previous turn-end counted is discarded. The counter file is
 *  only the fallback that distinguishes the 2nd attempt from the 3rd, which the boolean alone
 *  cannot: if the counter is unreadable/unwritable the flag still caps the gate at one block. */
export const MAX_BLOCKS_PER_TURN_END = 2;

/** Where a conducting session leaves its breadcrumb. Deliberately NOT `.harmony-task.json`: that
 *  file is written by `start-work` at the BUILD gate into a worktree root, so it does not exist
 *  during clarify/decompose/design/plan, and a stale copy in cwd can name a different ticket. */
export const BREADCRUMB_SUBDIR = 'conduct-sessions';

/** The Stop hook's stdin payload (the keys a live smoke confirmed the runtime sends). */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

/** What a conducting session writes at leg start (see harmony-conduct/SKILL.md §0). */
export interface ConductBreadcrumb {
  session_id?: string;
  /** The ticket this session is driving — a UUID or a visual id (B-123); both resolve in the CLI. */
  task_id?: string;
  ticket?: string;
  started_at?: string;
}

/** The row projection the gate decides from — the two clean-shape fields plus the child count. */
export interface StopGateRow extends CleanRowShape {
  non_archived_child_count?: number;
}

export type StopDecision =
  | { action: 'allow'; reason: string }
  | { action: 'block'; message: string }
  | { action: 'fail-open'; message: string };

/** Human-readable row state, for both the block reason and the degrade line. */
function describeRow(ticket: string, row: StopGateRow): string {
  return (
    `${ticket}: workflow_state=${row.workflow_state ?? 'null'}, ` +
    `awaiting_human_input=${row.awaiting_human_input ?? 'null'}, ` +
    `non_archived_children=${row.non_archived_child_count ?? 0}, ` +
    `pending_acceptance_event=${row.pending_acceptance_event_id ?? 'none'}`
  );
}

/** The whole decision, pure. Everything above it is transport; everything below it is I/O. */
export function decideStop(args: {
  ticket: string;
  row: StopGateRow;
  /** How many times this same turn-end has already been blocked (0 on a fresh turn-end). */
  blocksSoFar: number;
  /** The runtime's re-entry signal: true when this stop FOLLOWS a block. */
  stopHookActive: boolean;
}): StopDecision {
  const { ticket, row, stopHookActive } = args;

  // A stop arriving WITHOUT the re-entry flag is a fresh turn-end: any earlier count is stale.
  const blocksSoFar = stopHookActive ? args.blocksSoFar : 0;

  if (isCleanRowShape(row, row.non_archived_child_count ?? 0)) {
    return {
      action: 'allow',
      reason: `[harmony stop-gate] clean — ${describeRow(ticket, row)}`,
    };
  }

  if (blocksSoFar >= MAX_BLOCKS_PER_TURN_END) {
    return {
      action: 'fail-open',
      message:
        `[harmony stop-gate] DEGRADED — blocked this turn-end ${blocksSoFar}x and the ticket row ` +
        `still does not read as a clean stop. Allowing the turn to end so the terminal is never ` +
        `wedged. Unclassifiable row state — ${describeRow(ticket, row)}. Nothing on the board ` +
        `records this leg; a human should look at ${ticket}.`,
    };
  }

  return {
    action: 'block',
    message:
      `[harmony stop-gate] You are driving ${ticket} and this turn would end with nothing on the ` +
      `board. Row state — ${describeRow(ticket, row)}.\n` +
      `Leave the ticket in exactly one of the sanctioned shapes before you stop:\n` +
      `  * COMPOSE THE BRIEF for the gate you are at and pause on it (compose_brief — the pause ` +
      `happens ON the brief, never in the gap before it);\n` +
      `  * FILE AN ELICITATION ROUND (file_elicitation_round, trigger 'worker-question') if you ` +
      `hit a judgment call or a capability denial you cannot decide alone;\n` +
      `  * DEFER / PARK the ticket with an authored reason, or drive it to a terminal state, or ` +
      `decompose it into live children.\n` +
      `If the question is too small to be worth the human's time, DECIDE it, record the decision ` +
      `and its rationale as a ticket comment, and continue — do not stop for it.`,
  };
}

/** Everything the runner touches outside itself. Injected so the whole runner is testable. */
export interface StopGateDeps {
  /** The raw stdin payload. */
  input: string;
  /** The breadcrumb path the shell wrapper already `test -f`'d (argv[1]). */
  breadcrumbPath: string;
  env: Record<string, string | undefined>;
  /** Reads a file; MAY throw — the runner treats any throw as a fail-open. */
  readFile: (path: string) => string;
  /** Blocks-so-far for this session; MAY throw (the runner then treats it as 0). */
  readBlockCount: (sessionId: string) => number;
  /** Persists the blocks-so-far; MAY throw (a throw is swallowed — the cap degrades, never wedges). */
  writeBlockCount: (sessionId: string, count: number) => void;
  /** The row read — a CLI call in production. MAY throw / time out; any throw is a fail-open. */
  queryRow: (taskRef: string) => StopGateRow;
  /** stderr. */
  log: (line: string) => void;
}

/** Runs the gate and returns the PROCESS EXIT CODE: 2 blocks the turn-end, 0 allows it. */
export function runStopGate(deps: StopGateDeps): number {
  try {
    // AC3: the human-only escape switch. Checked here as well as in the shell wrapper so the
    // control works no matter which layer the operator's environment reaches.
    if ((deps.env[STOP_GATE_ESCAPE_ENV] ?? '') !== '') {
      deps.log(
        `[harmony stop-gate] DISABLED for this session via ${STOP_GATE_ESCAPE_ENV} — ` +
          `turn-end allowed without a board check.`,
      );
      return 0;
    }

    const payload = JSON.parse(deps.input) as StopHookInput;
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    if (sessionId === '') return 0; // no session to key anything on ⇒ nothing to enforce.

    const breadcrumb = JSON.parse(deps.readFile(deps.breadcrumbPath)) as ConductBreadcrumb;
    const taskRef = breadcrumb.task_id || breadcrumb.ticket || '';
    if (taskRef === '') return 0; // a breadcrumb naming no ticket gates nothing.

    // A breadcrumb that names a DIFFERENT session is not this session's; never gate on it.
    if (typeof breadcrumb.session_id === 'string' && breadcrumb.session_id !== sessionId) return 0;

    const ticket = breadcrumb.ticket || taskRef;
    const row = deps.queryRow(taskRef);
    const stopHookActive = payload.stop_hook_active === true;

    let blocksSoFar = 0;
    try {
      blocksSoFar = deps.readBlockCount(sessionId);
    } catch {
      blocksSoFar = 0; // unreadable counter ⇒ the stop_hook_active flag alone caps the gate.
    }

    const decision = decideStop({ ticket, row, blocksSoFar, stopHookActive });

    if (decision.action === 'block') {
      try {
        deps.writeBlockCount(sessionId, (stopHookActive ? blocksSoFar : 0) + 1);
      } catch {
        /* a counter we cannot persist degrades the cap; it never wedges the terminal. */
      }
      deps.log(decision.message);
      return 2;
    }

    if (decision.action === 'fail-open') {
      try {
        deps.writeBlockCount(sessionId, 0);
      } catch {
        /* nothing to do — we are already letting the stop through. */
      }
      deps.log(decision.message);
      return 0;
    }

    try {
      deps.writeBlockCount(sessionId, 0);
    } catch {
      /* ditto */
    }
    return 0;
  } catch (err) {
    // AC8. Every failure mode lands here: malformed stdin, an unreadable/garbled breadcrumb, a CLI
    // failure, a timeout, a network error. The stop is ALLOWED, with one quiet line for the log.
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.log(`[harmony stop-gate] could not run (${message}) — allowing the stop (fail-open).`);
    } catch {
      /* even logging is best-effort */
    }
    return 0;
  }
}
