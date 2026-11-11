// B-1423: the SEAT HOOKS — a seat's SessionStart board check and its Stop guard on the watch.
//
// A seat is an orchestrator session named by a seat profile (`<home>/seats/<name>.yml`, whose
// `session_id:` line is this session's id). Two hooks act for it, and ONLY for it:
//
//   * SessionStart (`hooks/seat-session-start.sh` → `dist/bin/seat-hook.js start <profile>`): runs
//     `harmony watch --once` and puts its summary in the session's context, so a resumed seat starts
//     from the board's current state. It never arms a watch and never fails the session start.
//   * Stop (`hooks/seat-stop-guard.sh` → `dist/bin/seat-hook.js stop <profile>`): blocks a turn-end
//     (exit 2, reason on stderr) when the seat's standing watch is not running — no heartbeat, a stale
//     one, a --once one, or no live lock holder — and names the exact re-arm command. It blocks at
//     most once per stop (`stop_hook_active`).
//
// The fast path — a session no profile names (every cloud leg, every ordinary session) — is in the
// shell wrappers: a directory test and one fixed-string grep, and node is never started. Nothing in
// this file runs for such a session.
//
// FAIL OPEN: any parse, read or unexpected error allows the stop and prints `{}` at start.
// The file formats are B-1422's contract (`docs/harmony-watch-files.md`); every read goes through
// `src/watch/seat-files.ts`.

import {
  defaultIsPidAlive,
  isLockHeld,
  isHeartbeatStale,
  isSafeName,
  scopeSlug,
  type Heartbeat,
  type ReadResult,
  type SeatProfile,
  type WatchLock,
  type WatchScope,
} from '../watch/seat-files.js';

/** How long the start hook lets `harmony watch --once` run (the hook entry's own timeout is 30 s). */
export const SEAT_START_WATCH_TIMEOUT_MS = 20_000;
/** The most watch output the start hook puts into the session's context. */
export const SEAT_START_MAX_OUTPUT = 6000;

export const UNWATCHED_RULE = 'If you end the turn anyway, your last line must say this seat is unwatched.';

/** The seat name is the profile file's basename without `.yml`; null when it is not a safe name. */
export function seatNameFromProfilePath(profilePath: string): string | null {
  const base = profilePath.split('/').pop() ?? '';
  if (!base.endsWith('.yml')) return null;
  const name = base.slice(0, -'.yml'.length);
  return isSafeName(name) ? name : null;
}

/** The watch scope a profile implies: its milestone, else the conductions scope. */
export function profileScope(profile: Pick<SeatProfile, 'milestone'>): WatchScope {
  return profile.milestone ? { kind: 'milestone', id: profile.milestone } : { kind: 'conductions' };
}

function scopeFlags(profile: Pick<SeatProfile, 'milestone'>): string {
  return profile.milestone ? `--milestone ${profile.milestone}` : '--conductions';
}

/** The exact command that re-arms the seat's standing watch. */
export function rearmCommand(seat: string, profile: Pick<SeatProfile, 'milestone'>, mode: 'until-event' | 'follow' = 'until-event'): string {
  return `harmony watch --seat ${seat} ${scopeFlags(profile)} --${mode}`;
}

/** The argv (after `harmony`) of the start hook's one-shot board check. */
export function watchOnceArgs(seat: string, profile: Pick<SeatProfile, 'milestone'>): string[] {
  return ['watch', '--once', '--seat', seat, ...(profile.milestone ? ['--milestone', profile.milestone] : [])];
}

function parseHookInput(input: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(input);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A profile rewritten for another session since the wrapper's grep no longer names this one. */
function namesAnotherSession(input: Record<string, unknown> | null, profile: SeatProfile): boolean {
  const id = input?.session_id;
  return typeof id === 'string' && id.length > 0 && profile.session_id !== id;
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

/** What running `harmony watch --once` produced. */
export interface WatchRunResult {
  /** Exit code; null when killed (timeout) or never started. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error (e.g. the CLI could not start). */
  error?: string;
}

export interface SeatStartArgs {
  input: string;
  seat: string | null;
  profile: ReadResult<SeatProfile>;
  /** Runs `harmony <args>` with a timeout. Only called when the profile reads ok. */
  runWatch: (args: string[]) => WatchRunResult;
  timeoutMs?: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (output truncated at ${max} characters; run the command by hand for the rest)`;
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

/** The text the start hook adds to the session's context. Pure. */
export function buildSeatStartContext(seat: string, profile: SeatProfile, run: WatchRunResult, timeoutMs = SEAT_START_WATCH_TIMEOUT_MS): string {
  const scope = profile.milestone ? ` (milestone ${profile.milestone})` : '';
  const cmd = `harmony ${watchOnceArgs(seat, profile).join(' ')}`;
  const lines = [`Harmony seat ${seat}${scope}: board check at session start`, ''];
  if (run.timedOut) {
    lines.push(`The board check \`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s. Run it by hand: \`${cmd}\``);
  } else if (run.error !== undefined || run.status === null) {
    lines.push(`The board check \`${cmd}\` could not run (${run.error ?? 'no exit code'}). Run it by hand: \`${cmd}\``);
  } else if (run.status !== 0) {
    const err = firstLine(run.stderr);
    lines.push(`The board check \`${cmd}\` failed with exit code ${run.status}${err ? `: ${err}` : ''}. Run it by hand: \`${cmd}\``);
  } else {
    const out = run.stdout.trim();
    lines.push(out ? truncate(out, SEAT_START_MAX_OUTPUT) : '(the board check printed nothing)');
  }
  lines.push('', `Your watch is not armed by this check; re-arm with: ${rearmCommand(seat, profile)}`);
  return lines.join('\n');
}

/** The full SessionStart decision: the JSON to print. Never throws; `{}` on anything unexpected. */
export function runSeatStart(args: SeatStartArgs): string {
  try {
    if (!args.seat || args.profile.status !== 'ok') return '{}';
    const profile = args.profile.value;
    if (namesAnotherSession(parseHookInput(args.input), profile)) return '{}';
    const run = args.runWatch(watchOnceArgs(args.seat, profile));
    const additionalContext = buildSeatStartContext(args.seat, profile, run, args.timeoutMs);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
  } catch {
    return '{}';
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export interface SeatStopDeps {
  seat: string | null;
  readProfile: () => ReadResult<SeatProfile>;
  readHeartbeat: (project: string, seat: string) => ReadResult<Heartbeat>;
  readLock: (project: string, seat: string, scope: WatchScope) => ReadResult<WatchLock>;
  now: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** This host's name (tests). */
  hostname?: string;
}

export type SeatStopDecision = { action: 'allow'; why: string } | { action: 'block'; reason: string };

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

/** The block reason: what was found, the re-arm command, and the unwatched rule. */
export function seatStopReason(seat: string, profile: SeatProfile, finding: string, mode: 'until-event' | 'follow' = 'until-event'): string {
  return [
    `Harmony seat ${seat}: your standing board watch is not running (${finding}).`,
    `Re-arm it before you end the turn: run \`${rearmCommand(seat, profile, mode)}\` in the background (run_in_background), and keep a Monitor on its output.`,
    UNWATCHED_RULE,
  ].join('\n');
}

/** The Stop decision. Pure apart from the injected reads. Never throws: an error allows the stop. */
export function decideSeatStop(input: string, deps: SeatStopDeps): SeatStopDecision {
  try {
    const payload = parseHookInput(input);
    if (!payload) return { action: 'allow', why: 'unparseable Stop payload' };
    if (payload.stop_hook_active === true) return { action: 'allow', why: 'stop_hook_active (already blocked once)' };
    const seat = deps.seat;
    if (!seat) return { action: 'allow', why: 'no seat name' };
    const pr = deps.readProfile();
    if (pr.status !== 'ok') return { action: 'allow', why: `profile ${pr.status}` };
    const profile = pr.value;
    if (namesAnotherSession(payload, profile)) return { action: 'allow', why: 'profile names another session' };
    const project = profile.project;
    if (!project || !isSafeName(project)) return { action: 'allow', why: 'profile has no usable project' };

    const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    // A newly acquired live lock covers startup before the first heartbeat is visible,
    // including a stale heartbeat left by the previous watch. Never grant grace to a dead pid.
    const startupLock = deps.readLock(project, seat, profileScope(profile));
    if (startupLock.status === 'ok') {
      const age = deps.now() - Date.parse(startupLock.value.started_at);
      if (age >= 0 && age < 30_000 && isLockHeld(startupLock.value, { isPidAlive, hostname: deps.hostname })) {
        return { action: 'allow', why: 'watch starting (live lock younger than 30s)' };
      }
    }
    const hb = deps.readHeartbeat(project, seat);
    if (hb.status === 'absent') return { action: 'block', reason: seatStopReason(seat, profile, 'no heartbeat') };
    if (hb.status !== 'ok') return { action: 'allow', why: `heartbeat ${hb.status}` };
    const beat = hb.value;
    const rearmMode = beat.mode === 'follow' ? 'follow' : 'until-event';
    if (beat.mode === 'once') {
      return { action: 'block', reason: seatStopReason(seat, profile, 'the last heartbeat is from a --once check, not a standing watch') };
    }
    if (isHeartbeatStale(beat, deps.now())) {
      const ref = Date.parse(beat.last_fetch_at ?? beat.started_at);
      const age = Number.isNaN(ref) ? 'heartbeat timestamp unreadable' : `heartbeat ${formatAge(deps.now() - ref)} old`;
      return { action: 'block', reason: seatStopReason(seat, profile, age, rearmMode) };
    }

    // The lock for the watch the profile implies. When the heartbeat's watch runs another scope, or
    // that lock cannot be read, the heartbeat's own pid stands in for the lock holder.
    const scope = profileScope(profile);
    let slug: string | null = null;
    try {
      slug = scopeSlug(scope);
    } catch {
      slug = null;
    }
    const lock = slug !== null && slug === beat.scope ? deps.readLock(project, seat, scope) : null;
    if (lock && lock.status === 'absent') {
      return { action: 'block', reason: seatStopReason(seat, profile, `no lock for scope ${slug}`, rearmMode) };
    }
    if (lock && lock.status === 'ok') {
      if (isLockHeld(lock.value, { isPidAlive, hostname: deps.hostname })) return { action: 'allow', why: 'watch live' };
      return { action: 'block', reason: seatStopReason(seat, profile, `lock holder pid ${lock.value.pid} is dead`, rearmMode) };
    }
    if (isPidAlive(beat.pid)) return { action: 'allow', why: 'watch live (heartbeat pid)' };
    return { action: 'block', reason: seatStopReason(seat, profile, `watch pid ${beat.pid} is dead`, rearmMode) };
  } catch (err) {
    return { action: 'allow', why: `error: ${(err as Error).message}` };
  }
}

/** The Stop hook's exit code: 2 blocks (reason on stderr), 0 allows. */
export function runSeatStop(input: string, deps: SeatStopDeps, log: (text: string) => void): number {
  const d = decideSeatStop(input, deps);
  if (d.action === 'block') {
    log(d.reason);
    return 2;
  }
  return 0;
}
