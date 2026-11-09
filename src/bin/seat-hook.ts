#!/usr/bin/env node
// B-1423: the seat-hook process. Thin I/O shell around `src/hooks/seat-hook.ts`: every decision lives
// there (and is unit-tested there). This file only supplies stdin, the seat files, the CLI run and the
// exit code.
//
// Invoked by `hooks/seat-session-start.sh` / `hooks/seat-stop-guard.sh`, which have ALREADY found a
// seat profile naming this session (the fast path: no profile ⇒ node is never started).
//
// Usage: <stdin: the hook JSON> node dist/bin/seat-hook.js start|stop <profile-path>

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harmonyHome, readHeartbeat, readLock, readSeatProfile } from '../watch/seat-files.js';
import {
  SEAT_START_WATCH_TIMEOUT_MS,
  runSeatStart,
  runSeatStop,
  seatNameFromProfilePath,
  type WatchRunResult,
} from '../hooks/seat-hook.js';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(): number {
  const mode = process.argv[2];
  const profilePath = process.argv[3] ?? '';
  const seat = seatNameFromProfilePath(profilePath);
  // The home the wrapper matched in: <home>/seats/<name>.yml.
  const home = basename(dirname(profilePath)) === 'seats' ? dirname(dirname(profilePath)) : harmonyHome();
  const input = readStdin();

  if (mode === 'start') {
    const harmonyCli = join(dirname(fileURLToPath(import.meta.url)), 'harmony.js');
    const out = runSeatStart({
      input,
      seat,
      profile: seat ? readSeatProfile(seat, { home }) : { status: 'absent', path: profilePath },
      timeoutMs: SEAT_START_WATCH_TIMEOUT_MS,
      runWatch: (args): WatchRunResult => {
        const r = spawnSync(process.execPath, [harmonyCli, ...args], {
          encoding: 'utf8',
          timeout: SEAT_START_WATCH_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 4 * 1024 * 1024,
        });
        const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
        return {
          status: r.status,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          timedOut,
          error: r.error && !timedOut ? r.error.message : undefined,
        };
      },
    });
    process.stdout.write(`${out}\n`);
    return 0;
  }

  if (mode === 'stop') {
    return runSeatStop(
      input,
      {
        seat,
        readProfile: () => (seat ? readSeatProfile(seat, { home }) : { status: 'absent', path: profilePath }),
        readHeartbeat: (project, s) => readHeartbeat(project, s, { home }),
        readLock: (project, s, scope) => readLock(project, s, scope, { home }),
        now: () => Date.now(),
      },
      (text) => process.stderr.write(`${text}\n`),
    );
  }
  return 0;
}

function failOpen(): number {
  // Fail open: never fail a session start, never block a stop on an error.
  if (process.argv[2] === 'start') process.stdout.write('{}\n');
  return 0;
}

let code: number;
try {
  code = main();
} catch {
  code = failOpen();
}
process.exit(code);
