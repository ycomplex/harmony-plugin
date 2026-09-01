#!/usr/bin/env node
import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// src/bin/stop-gate.ts
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/daemon/classify.ts
var TICKET_TERMINAL_STATES = ["Verified", "Cancelled", "Parked"];
function classifyCleanRowShape(row, nonArchivedChildCount) {
  if (row.awaiting_human_input === true) return "clean-pause";
  const state = row.workflow_state ?? null;
  if (state !== null && TICKET_TERMINAL_STATES.includes(state)) {
    return "terminal";
  }
  if (state === "Decomposed" && nonArchivedChildCount >= 1 && row.awaiting_human_input === false) {
    return "split-umbrella";
  }
  return null;
}
function isCleanRowShape(row, nonArchivedChildCount) {
  return classifyCleanRowShape(row, nonArchivedChildCount) !== null;
}

// src/hooks/stop-gate.ts
var STOP_GATE_ESCAPE_ENV = "HARMONY_STOP_GATE_OFF";
var MAX_BLOCKS_PER_TURN_END = 2;
function describeRow(ticket, row) {
  return `${ticket}: workflow_state=${row.workflow_state ?? "null"}, awaiting_human_input=${row.awaiting_human_input ?? "null"}, non_archived_children=${row.non_archived_child_count ?? 0}`;
}
function decideStop(args) {
  const { ticket, row, stopHookActive } = args;
  const blocksSoFar = stopHookActive ? args.blocksSoFar : 0;
  if (isCleanRowShape(row, row.non_archived_child_count ?? 0)) {
    return {
      action: "allow",
      reason: `[harmony stop-gate] clean \u2014 ${describeRow(ticket, row)}`
    };
  }
  if (blocksSoFar >= MAX_BLOCKS_PER_TURN_END) {
    return {
      action: "fail-open",
      message: `[harmony stop-gate] DEGRADED \u2014 blocked this turn-end ${blocksSoFar}x and the ticket row still does not read as a clean stop. Allowing the turn to end so the terminal is never wedged. Unclassifiable row state \u2014 ${describeRow(ticket, row)}. Nothing on the board records this leg; a human should look at ${ticket}.`
    };
  }
  return {
    action: "block",
    message: `[harmony stop-gate] You are driving ${ticket} and this turn would end with nothing on the board. Row state \u2014 ${describeRow(ticket, row)}.
Leave the ticket in exactly one of the sanctioned shapes before you stop:
  * COMPOSE THE BRIEF for the gate you are at and pause on it (compose_brief \u2014 the pause happens ON the brief, never in the gap before it);
  * FILE AN ELICITATION ROUND (file_elicitation_round, trigger 'worker-question') if you hit a judgment call or a capability denial you cannot decide alone;
  * DEFER / PARK the ticket with an authored reason, or drive it to a terminal state, or decompose it into live children.
If the question is too small to be worth the human's time, DECIDE it, record the decision and its rationale as a ticket comment, and continue \u2014 do not stop for it.`
  };
}
function runStopGate(deps) {
  try {
    if ((deps.env[STOP_GATE_ESCAPE_ENV] ?? "") !== "") {
      deps.log(
        `[harmony stop-gate] DISABLED for this session via ${STOP_GATE_ESCAPE_ENV} \u2014 turn-end allowed without a board check.`
      );
      return 0;
    }
    const payload = JSON.parse(deps.input);
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    if (sessionId === "") return 0;
    const breadcrumb = JSON.parse(deps.readFile(deps.breadcrumbPath));
    const taskRef = breadcrumb.task_id || breadcrumb.ticket || "";
    if (taskRef === "") return 0;
    if (typeof breadcrumb.session_id === "string" && breadcrumb.session_id !== sessionId) return 0;
    const ticket = breadcrumb.ticket || taskRef;
    const row = deps.queryRow(taskRef);
    const stopHookActive = payload.stop_hook_active === true;
    let blocksSoFar = 0;
    try {
      blocksSoFar = deps.readBlockCount(sessionId);
    } catch {
      blocksSoFar = 0;
    }
    const decision = decideStop({ ticket, row, blocksSoFar, stopHookActive });
    if (decision.action === "block") {
      try {
        deps.writeBlockCount(sessionId, (stopHookActive ? blocksSoFar : 0) + 1);
      } catch {
      }
      deps.log(decision.message);
      return 2;
    }
    if (decision.action === "fail-open") {
      try {
        deps.writeBlockCount(sessionId, 0);
      } catch {
      }
      deps.log(decision.message);
      return 0;
    }
    try {
      deps.writeBlockCount(sessionId, 0);
    } catch {
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.log(`[harmony stop-gate] could not run (${message}) \u2014 allowing the stop (fail-open).`);
    } catch {
    }
    return 0;
  }
}

// src/bin/stop-gate.ts
var CLI_TIMEOUT_MS = 2e4;
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
var breadcrumbPath = process.argv[2] ?? "";
var here = dirname(fileURLToPath(import.meta.url));
var harmonyCli = join(here, "harmony.js");
var exitCode = runStopGate({
  input: readStdin(),
  breadcrumbPath,
  env: process.env,
  readFile: (path) => readFileSync(path, "utf8"),
  readBlockCount: (sessionId) => {
    const raw = readFileSync(blockCountPath(sessionId), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  writeBlockCount: (sessionId, count) => {
    writeFileSync(blockCountPath(sessionId), `${count}
`, "utf8");
  },
  queryRow: (taskRef) => {
    const out = execFileSync(
      process.execPath,
      [harmonyCli, "--json", "tasks", "clean-check", taskRef],
      { encoding: "utf8", timeout: CLI_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    );
    return JSON.parse(out);
  },
  log: (line) => process.stderr.write(`${line}
`)
});
function blockCountPath(sessionId) {
  return join(dirname(breadcrumbPath), `${sessionId}.stop-blocks`);
}
process.exit(exitCode);
