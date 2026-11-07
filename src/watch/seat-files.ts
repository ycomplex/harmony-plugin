/**
 * Seat files: the one reader, parser and writer for the four files a `harmony watch`
 * and a seat share (B-1422).
 *
 * B-1423's seat hooks import this module, so the file formats below are a CONTRACT.
 * The prose contract is `docs/harmony-watch-files.md`; change both together.
 *
 * All four files live under `${HARMONY_HOME:-$HOME/.harmony}`:
 *   - seat profile  `<home>/seats/<name>.yml`
 *   - cursor        `<home>/watch/<project-key>/<seat>.json`
 *   - heartbeat     `<home>/watch/<project-key>/<seat>.heartbeat.json`
 *   - lock          `<home>/watch/<project-key>/<seat>.<scope-slug>.lock`
 *
 * Readers never throw: they return a `ReadResult` so a hook can fail open.
 * Path helpers throw on an unsafe seat name or project key.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Home, names, scopes
// ---------------------------------------------------------------------------

export interface HomeOpts {
  /** Override the Harmony home directory (tests). Defaults to `harmonyHome()`. */
  home?: string;
}

/** `$HARMONY_HOME`, else `~/.harmony`. An empty `HARMONY_HOME` counts as unset. */
export function harmonyHome(home?: string): string {
  if (home) return home;
  const env = process.env.HARMONY_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), '.harmony');
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** True for a seat name or project key that is safe as one path segment. */
export function isSafeName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

function assertSafeName(kind: string, name: unknown): asserts name is string {
  if (!isSafeName(name)) {
    throw new Error(`invalid ${kind} ${JSON.stringify(name)}: only [A-Za-z0-9._-] allowed`);
  }
}

export type WatchScope =
  | { kind: 'milestone'; id: string }
  | { kind: 'conductions' }
  | { kind: 'keys'; keys: string[] };

export const SCOPE_SLUG_MAX = 80;

function slugPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Deterministic, filesystem-safe slug of a watch scope:
 * `milestone-<id>`, `conductions`, or `keys-<sorted keys joined by '-'>`.
 * Lowercase `[a-z0-9-]` only. A slug longer than 80 chars is truncated and
 * suffixed with `-<8 hex chars of sha256(full slug)>` so it stays unique.
 */
export function scopeSlug(scope: WatchScope): string {
  let slug: string;
  switch (scope.kind) {
    case 'milestone': {
      const id = slugPart(String(scope.id ?? ''));
      if (!id) throw new Error('milestone scope needs a non-empty id');
      slug = `milestone-${id}`;
      break;
    }
    case 'conductions':
      slug = 'conductions';
      break;
    case 'keys': {
      const keys = [...new Set((scope.keys ?? []).map((k) => slugPart(String(k))).filter(Boolean))].sort();
      if (keys.length === 0) throw new Error('keys scope needs at least one key');
      slug = `keys-${keys.join('-')}`;
      break;
    }
    default:
      throw new Error(`unknown scope kind ${JSON.stringify((scope as { kind?: unknown }).kind)}`);
  }
  if (slug.length <= SCOPE_SLUG_MAX) return slug;
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  const head = slug.slice(0, SCOPE_SLUG_MAX - hash.length - 1).replace(/-+$/, '');
  return `${head}-${hash}`;
}

// ---------------------------------------------------------------------------
// Path helpers (throw on unsafe names)
// ---------------------------------------------------------------------------

export function seatProfilePath(name: string, opts: HomeOpts = {}): string {
  assertSafeName('seat name', name);
  return join(harmonyHome(opts.home), 'seats', `${name}.yml`);
}

export function watchDir(projectKey: string, opts: HomeOpts = {}): string {
  assertSafeName('project key', projectKey);
  return join(harmonyHome(opts.home), 'watch', projectKey);
}

export function cursorPath(projectKey: string, seat: string, opts: HomeOpts = {}): string {
  assertSafeName('seat name', seat);
  return join(watchDir(projectKey, opts), `${seat}.json`);
}

export function heartbeatPath(projectKey: string, seat: string, opts: HomeOpts = {}): string {
  assertSafeName('seat name', seat);
  return join(watchDir(projectKey, opts), `${seat}.heartbeat.json`);
}

export function lockPath(projectKey: string, seat: string, scope: WatchScope, opts: HomeOpts = {}): string {
  assertSafeName('seat name', seat);
  return join(watchDir(projectKey, opts), `${seat}.${scopeSlug(scope)}.lock`);
}

// ---------------------------------------------------------------------------
// Types and schemas
// ---------------------------------------------------------------------------

export interface SeatProfile {
  session_id: string | null;
  project: string | null;
  milestone: string | null;
  anchor: string | null;
  owns: string[];
  held_for_founder: string[];
  remind: string | null;
}

export type HeartbeatMode = 'until-event' | 'follow' | 'once';
export type LockMode = 'until-event' | 'follow';
export type WatchHealth = 'ok' | 'degraded' | 'offline' | 'auth-failed';

export interface Heartbeat {
  schema: 1;
  pid: number;
  seat: string;
  /** Scope slug (`scopeSlug`). */
  scope: string;
  mode: HeartbeatMode;
  poll_interval_s: number;
  started_at: string;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  health: WatchHealth;
  seq: number;
}

export interface WatchLock {
  schema: 1;
  pid: number;
  hostname: string;
  /** Scope slug (`scopeSlug`). */
  scope: string;
  mode: LockMode;
  started_at: string;
}

export interface CursorTicket {
  key: string;
  state: string | null;
  awaiting: boolean;
  reason: string | null;
  ref_id: string | null;
  iteration: number | null;
  conduction_status: string | null;
  leg_ended_at: string | null;
  waiting_on: unknown;
  first_seen: string;
  last_reported: string | null;
  reminders: number;
}

export interface WatchCursor {
  schema: 1;
  project: string;
  seat: string;
  seq: number;
  updated_at: string;
  /** Keyed by task uuid. */
  tickets: Record<string, CursorTicket>;
}

export type ReadResult<T> =
  | { status: 'ok'; value: T; path: string }
  | { status: 'absent'; path: string }
  | { status: 'malformed'; path: string; error: string };

const nullableString = z.string().nullable();
const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO timestamp');
const nullableIso = isoString.nullable();
const nonNegInt = z.number().int().nonnegative();
const pidSchema = z.number().int().positive();

const stringList = z
  .union([z.array(z.string()), z.null()])
  .optional()
  .transform((v) => v ?? []);

const optionalNullableString = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === undefined || v === null ? null : String(v)));

const SeatProfileSchema = z.object({
  session_id: optionalNullableString,
  project: optionalNullableString,
  milestone: optionalNullableString,
  anchor: optionalNullableString,
  owns: stringList,
  held_for_founder: stringList,
  remind: optionalNullableString.refine((v) => v === null || parseDuration(v) !== null, {
    message: 'remind must be a duration like 20m, 1h, 90s',
  }),
});

export const HeartbeatSchema = z.object({
  schema: z.literal(1),
  pid: pidSchema,
  seat: z.string(),
  scope: z.string(),
  mode: z.enum(['until-event', 'follow', 'once']),
  poll_interval_s: z.number().positive(),
  started_at: isoString,
  last_fetch_at: nullableIso,
  last_ok_at: nullableIso,
  health: z.enum(['ok', 'degraded', 'offline', 'auth-failed']),
  seq: nonNegInt,
});

export const WatchLockSchema = z.object({
  schema: z.literal(1),
  pid: pidSchema,
  hostname: z.string(),
  scope: z.string(),
  mode: z.enum(['until-event', 'follow']),
  started_at: isoString,
});

export const CursorTicketSchema = z.object({
  key: z.string(),
  state: nullableString,
  awaiting: z.boolean(),
  reason: nullableString,
  ref_id: nullableString,
  iteration: z.number().int().nullable(),
  conduction_status: nullableString,
  leg_ended_at: nullableIso,
  waiting_on: z.unknown().transform((v) => (v === undefined ? null : v)),
  first_seen: isoString,
  last_reported: nullableIso,
  reminders: nonNegInt,
});

export const WatchCursorSchema = z.object({
  schema: z.literal(1),
  project: z.string(),
  seat: z.string(),
  seq: nonNegInt,
  updated_at: isoString,
  tickets: z.record(z.string(), CursorTicketSchema),
});

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a duration like `20m`, `1h`, `90s`, `1h30m` into milliseconds.
 * Returns null for anything else (bare numbers, unknown units, zero, negatives).
 */
export function parseDuration(s: string): number | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (!/^(\d+[smhd])+$/.test(t)) return null;
  let total = 0;
  for (const m of t.matchAll(/(\d+)([smhd])/g)) total += Number(m[1]) * UNIT_MS[m[2]];
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}

// ---------------------------------------------------------------------------
// Readers (never throw)
// ---------------------------------------------------------------------------

type RawRead = { ok: true; text: string } | { ok: false; absent: true } | { ok: false; absent: false; error: string };

function readRaw(path: string): RawRead {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, absent: true };
    return { ok: false, absent: false, error: `unreadable: ${(err as Error).message}` };
  }
}

function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function readJsonFile<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): ReadResult<T> {
  const raw = readRaw(path);
  if (!raw.ok) return raw.absent ? { status: 'absent', path } : { status: 'malformed', path, error: raw.error };
  let data: unknown;
  try {
    data = JSON.parse(raw.text);
  } catch (err) {
    return { status: 'malformed', path, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'malformed', path, error: 'not a JSON object' };
  }
  const schemaVersion = (data as { schema?: unknown }).schema;
  if (schemaVersion !== 1) {
    return { status: 'malformed', path, error: `unsupported schema ${JSON.stringify(schemaVersion ?? null)} (expected 1)` };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { status: 'malformed', path, error: zodError(parsed.error) };
  return { status: 'ok', value: parsed.data, path };
}

function unsafePath(...parts: string[]): string {
  return parts.map((p) => String(p)).join('/');
}

export function readSeatProfile(name: string, opts: HomeOpts = {}): ReadResult<SeatProfile> {
  if (!isSafeName(name)) {
    return {
      status: 'malformed',
      path: unsafePath(harmonyHome(opts.home), 'seats', `${String(name)}.yml`),
      error: 'invalid seat name',
    };
  }
  const path = seatProfilePath(name, opts);
  const raw = readRaw(path);
  if (!raw.ok) return raw.absent ? { status: 'absent', path } : { status: 'malformed', path, error: raw.error };
  let data: unknown;
  try {
    data = parseYaml(raw.text);
  } catch (err) {
    return { status: 'malformed', path, error: `invalid YAML: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'malformed', path, error: 'not a YAML mapping' };
  }
  const parsed = SeatProfileSchema.safeParse(data);
  if (!parsed.success) return { status: 'malformed', path, error: zodError(parsed.error) };
  return { status: 'ok', value: parsed.data, path };
}

function badNames(projectKey: string, seat: string, opts: HomeOpts, file: string): ReadResult<never> | null {
  if (isSafeName(projectKey) && isSafeName(seat)) return null;
  return {
    status: 'malformed',
    path: unsafePath(harmonyHome(opts.home), 'watch', String(projectKey), file),
    error: !isSafeName(projectKey) ? 'invalid project key' : 'invalid seat name',
  };
}

export function readHeartbeat(projectKey: string, seat: string, opts: HomeOpts = {}): ReadResult<Heartbeat> {
  const bad = badNames(projectKey, seat, opts, `${String(seat)}.heartbeat.json`);
  if (bad) return bad;
  return readJsonFile(heartbeatPath(projectKey, seat, opts), HeartbeatSchema) as ReadResult<Heartbeat>;
}

export function readCursor(projectKey: string, seat: string, opts: HomeOpts = {}): ReadResult<WatchCursor> {
  const bad = badNames(projectKey, seat, opts, `${String(seat)}.json`);
  if (bad) return bad;
  return readJsonFile(cursorPath(projectKey, seat, opts), WatchCursorSchema) as ReadResult<WatchCursor>;
}

export function readLock(
  projectKey: string,
  seat: string,
  scope: WatchScope,
  opts: HomeOpts = {},
): ReadResult<WatchLock> {
  const bad = badNames(projectKey, seat, opts, `${String(seat)}.lock`);
  if (bad) return bad;
  let path: string;
  try {
    path = lockPath(projectKey, seat, scope, opts);
  } catch (err) {
    return {
      status: 'malformed',
      path: unsafePath(harmonyHome(opts.home), 'watch', projectKey, `${seat}.lock`),
      error: (err as Error).message,
    };
  }
  return readJsonFile(path, WatchLockSchema) as ReadResult<WatchLock>;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export const HEARTBEAT_STALE_MIN_MS = 5 * 60_000;

/** Staleness threshold for a heartbeat: three poll intervals, five-minute minimum. */
export function heartbeatStaleAfterMs(hb: Pick<Heartbeat, 'poll_interval_s'>): number {
  return Math.max(3 * hb.poll_interval_s * 1000, HEARTBEAT_STALE_MIN_MS);
}

/**
 * B-1423's rule: stale when `now - (last_fetch_at ?? started_at)` exceeds
 * `max(3 * poll_interval_s * 1000, 5 * 60_000)`. An unparseable timestamp is stale.
 */
export function isHeartbeatStale(
  hb: Pick<Heartbeat, 'poll_interval_s' | 'last_fetch_at' | 'started_at'>,
  now: number = Date.now(),
): boolean {
  const ref = Date.parse(hb.last_fetch_at ?? hb.started_at);
  if (Number.isNaN(ref)) return true;
  return now - ref > heartbeatStaleAfterMs(hb);
}

/** `process.kill(pid, 0)`: EPERM means alive (another user's process), ESRCH means dead. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockCheckOpts {
  isPidAlive?: (pid: number) => boolean;
  /** Override this host's name (tests). Defaults to `os.hostname()`. */
  hostname?: string;
}

/**
 * True iff the lock is held. A lock written on this host is held while its pid is alive.
 * A lock written on ANOTHER host counts as held: its pid cannot be checked from here,
 * so it is never taken over automatically.
 */
export function isLockHeld(lock: Pick<WatchLock, 'pid' | 'hostname'>, opts: LockCheckOpts = {}): boolean {
  const here = opts.hostname ?? osHostname();
  if (lock.hostname !== here) return true;
  return (opts.isPidAlive ?? defaultIsPidAlive)(lock.pid);
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
}

function writeFileSynced(path: string, content: string, flags: string): void {
  const fd = openSync(path, flags, 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort: some platforms cannot fsync a directory
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** mkdir -p, write `<path>.tmp-<pid>-<random>`, fsync, rename over `path`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, jsonText(value));
}

function writeTextAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = tmpPathFor(path);
  try {
    writeFileSynced(tmp, text, 'wx');
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  fsyncDir(dir);
}

export function writeHeartbeat(projectKey: string, seat: string, hb: Heartbeat, opts: HomeOpts = {}): string {
  const path = heartbeatPath(projectKey, seat, opts);
  writeJsonAtomic(path, HeartbeatSchema.parse(hb));
  return path;
}

export function writeCursor(projectKey: string, seat: string, cursor: WatchCursor, opts: HomeOpts = {}): string {
  const path = cursorPath(projectKey, seat, opts);
  writeJsonAtomic(path, WatchCursorSchema.parse(cursor));
  return path;
}

/**
 * Render a seat profile as YAML. `session_id` is always the first line, as a plain
 * `session_id: <id>` (B-1423 greps `~/.harmony/seats/*.yml` for it).
 */
export function formatSeatProfile(profile: SeatProfile): string {
  if (profile.session_id !== null && !SAFE_NAME.test(profile.session_id)) {
    throw new Error('session_id must match [A-Za-z0-9._-]+');
  }
  if (profile.remind !== null && parseDuration(profile.remind) === null) {
    throw new Error(`invalid remind duration ${JSON.stringify(profile.remind)}`);
  }
  const { session_id, ...rest } = profile;
  const head = `session_id: ${session_id === null ? 'null' : session_id}\n`;
  return head + stringifyYaml(rest);
}

/** Write a seat profile atomically (the seat writes it from its grant). */
export function writeSeatProfile(name: string, profile: SeatProfile, opts: HomeOpts = {}): string {
  const path = seatProfilePath(name, opts);
  writeTextAtomic(path, formatSeatProfile(profile));
  return path;
}

export interface LockOpts extends HomeOpts, LockCheckOpts {
  /** Pid recorded in / matched against the lock. Defaults to `process.pid`. */
  pid?: number;
  /** Clock for `started_at` (tests). */
  now?: () => Date;
}

export type AcquireResult = { status: 'acquired'; lock: WatchLock; path: string } | { status: 'held'; holder: WatchLock; path: string };

/**
 * Take the lock for (project, seat, scope). Only `--until-event` and `--follow` take it.
 *
 * Exclusive create: the lock body is written and fsynced to a tmp file, then hard-linked
 * to the lock path, which fails with EEXIST when the lock exists (the same guarantee as
 * `open(..., 'wx')`, without a window where a reader sees an empty lock).
 * If the lock exists but is not held (dead pid on this host, or malformed), it is
 * unlinked and the create is retried once. A held lock returns `{ status: 'held', holder }`.
 */
export function acquireLock(
  projectKey: string,
  seat: string,
  scope: WatchScope,
  mode: LockMode,
  opts: LockOpts = {},
): AcquireResult {
  const path = lockPath(projectKey, seat, scope, opts);
  const lock: WatchLock = WatchLockSchema.parse({
    schema: 1,
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname ?? osHostname(),
    scope: scopeSlug(scope),
    mode,
    started_at: (opts.now ? opts.now() : new Date()).toISOString(),
  }) as WatchLock;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPathFor(path);
  writeFileSynced(tmp, jsonText(lock), 'wx');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, path);
        fsyncDir(dirname(path));
        return { status: 'acquired', lock, path };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const existing = readLock(projectKey, seat, scope, opts);
      if (existing.status === 'ok' && isLockHeld(existing.value, opts)) {
        return { status: 'held', holder: existing.value, path };
      }
      if (attempt === 0) {
        try {
          unlinkSync(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
    // Lost the takeover race: someone re-created it between our unlink and link.
    const now = readLock(projectKey, seat, scope, opts);
    if (now.status === 'ok') return { status: 'held', holder: now.value, path };
    throw new Error(`could not acquire lock ${path}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

/**
 * Remove the lock only if it records `opts.pid ?? process.pid`. Returns true when removed.
 * A malformed, absent, or foreign lock is left alone.
 */
export function releaseLock(projectKey: string, seat: string, scope: WatchScope, opts: LockOpts = {}): boolean {
  const existing = readLock(projectKey, seat, scope, opts);
  if (existing.status !== 'ok') return false;
  if (existing.value.pid !== (opts.pid ?? process.pid)) return false;
  if (existing.value.hostname !== (opts.hostname ?? osHostname())) return false;
  try {
    unlinkSync(existing.path);
    return true;
  } catch {
    return false;
  }
}
