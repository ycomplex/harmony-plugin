#!/usr/bin/env node
// B-870: the Stop-hook process. Thin I/O shell around `src/hooks/stop-gate.ts` — every decision
// lives there (and is unit-tested there); this file only supplies stdin, the filesystem, the CLI
// read, and the exit code.
//
// Invoked by `hooks/stop-gate.sh`, which has ALREADY established that this session has a conduct
// breadcrumb (the AC9 fast path: no breadcrumb ⇒ the wrapper exits 0 without starting node).
//
// Usage: <stdin: the Stop hook JSON> node dist/bin/stop-gate.js <breadcrumb-path>

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStopGate, type StopGateRow } from '../hooks/stop-gate.js';

/** The row read must never outlive the human's patience — a hung network call fails OPEN (AC8). */
const CLI_TIMEOUT_MS = 20_000;

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const breadcrumbPath = process.argv[2] ?? '';
const here = dirname(fileURLToPath(import.meta.url));
const harmonyCli = join(here, 'harmony.js');

const exitCode = runStopGate({
  input: readStdin(),
  breadcrumbPath,
  env: process.env,
  readFile: (path) => readFileSync(path, 'utf8'),
  readBlockCount: (sessionId) => {
    const raw = readFileSync(blockCountPath(sessionId), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  writeBlockCount: (sessionId, count) => {
    writeFileSync(blockCountPath(sessionId), `${count}\n`, 'utf8');
  },
  queryRow: (taskRef) => {
    const out = execFileSync(
      process.execPath,
      [harmonyCli, '--json', 'tasks', 'clean-check', taskRef],
      { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out) as StopGateRow;
  },
  log: (line) => process.stderr.write(`${line}\n`),
});

/** The per-session block counter sits beside the breadcrumb it belongs to. */
function blockCountPath(sessionId: string): string {
  return join(dirname(breadcrumbPath), `${sessionId}.stop-blocks`);
}

process.exit(exitCode);
