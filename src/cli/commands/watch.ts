/**
 * `harmony watch` (B-1422): a seat's view of the board, as events.
 *
 *   harmony watch [keys...] | --milestone <id> | --conductions
 *                 [--seat <name>] [--until-event | --follow | --once]
 *                 [--remind <dur>] [--max-wait <dur>] [--json]
 *   harmony watch status --seat <name>
 *
 * Exactly one scope. At most one mode; with none, `--once`. `--until-event` and `--follow` need
 * `--seat` (the lock, cursor and heartbeat are keyed by it) and take the lock; `--once` and
 * `status` never lock, and `--once` never writes the cursor or the heartbeat.
 *
 * Exit codes: 0 event (until-event) / done (once, follow); 3 `--max-wait` passed with nothing
 * seat-owned (or `--once` could not reach the board); 2 bad arguments, a lock held by another
 * watch, a rejected token at startup, a scope that cannot resolve (a key, or a milestone, not in
 * the CLI's active project), or a seat profile whose `project:` is not that project. `status`:
 * 0 alive, 1 none or stale.
 *
 * Every run starts with a `start` event naming the board it reads: the project's name and key,
 * the target (`prod` / `staging` / `custom`, from the Supabase URL the CLI uses) and the scope
 * with its ticket count. It is `info` and never ends an `--until-event` wait.
 *
 * Files and formats: docs/harmony-watch-files.md. Output: one line per event on stdout (`--json`:
 * one JSON object per line); health and start lines are events too. Diagnostics go to stderr.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from '../../auth.js';
import { harmonyEnv } from '../../env.js';
import { startHintSubscription, type HintChannelLike } from '../../daemon/hint-subscription.js';
import { getActiveProject, type ProjectConfig } from '../config.js';
import { resolveSupabaseTarget } from '../resolve-supabase-target.js';
import { createBoardReader, type BoardReader, type MilestoneInfo, type ProjectInfo } from '../../watch/board-read.js';
import { healthEvent, ownerFor, startEvent, type WatchEvent } from '../../watch/classify.js';
import { resolveEnvironment } from '../../tools/environment.js';
import type { CurrentRow } from '../../watch/cursor.js';
import {
  createGuardedClient,
  installProcessGuards,
  isAuthError,
  safeErrorMessage,
  type AuthLike,
  type GuardHealth,
  type ProcessGuardHealth,
} from '../../watch/guarded-client.js';
import { retryWithBackoff, runWatch, ONCE_MAX_ATTEMPTS, type HintLike, type WatchMode } from '../../watch/loop.js';
import { openSeatStarts } from '../../watch/markers.js';
import {
  acquireLock,
  isHeartbeatStale,
  isSafeName,
  listLocks,
  listWatchProjects,
  parseDuration,
  readCursor,
  readHeartbeat,
  readSeatProfile,
  releaseLock,
  scopeSlug,
  writeCursor,
  writeHeartbeat,
  type Heartbeat,
  type SeatProfile,
  type WatchCursor,
  type WatchScope,
} from '../../watch/seat-files.js';

/** Auth as the watch needs it (a real HarmonyAuth satisfies it). */
export interface WatchAuth extends AuthLike {
  getProjectId(): string;
  forceRefresh(): Promise<void>;
}

export interface WatchHints {
  source: HintLike;
  isDead(): boolean;
  close(): Promise<void>;
}

/** Everything impure the command uses, injectable for tests. */
export interface WatchCliDeps {
  makeAuth(): WatchAuth;
  makeClient(auth: WatchAuth, onHealth: (h: GuardHealth) => void): SupabaseClient;
  makeReader(client: SupabaseClient, projectId: string): BoardReader;
  startHints(client: SupabaseClient, auth: WatchAuth, projectId: string, pollMs: number, log: (l: string) => void): WatchHints | null;
  installGuards(onHealth: (h: ProcessGuardHealth) => void): () => void;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  out(line: string): void;
  err(line: string): void;
  home?: string;
  /** Signals that stop a running watch. */
  onSignal(handler: (sig: string) => void): () => void;
  pollMs?: number;
  hintDelayMs?: number;
  settleMs?: number;
  /** The board target of a Supabase URL (default: src/tools/environment.ts's resolver). */
  resolveTarget?(url: string): Promise<BoardTarget>;
  /** The CLI's active project config name, read locally; null when there is none. */
  activeProjectName?(): string | null;
}

export type BoardTarget = 'prod' | 'staging' | 'custom';

/** The target get_project reports for this URL: the same resolver, never a second KNOWN_REFS. */
export async function resolveBoardTarget(url: string): Promise<BoardTarget> {
  try {
    return (await resolveEnvironment(process.env, import.meta.url, null, url || undefined)).target;
  } catch {
    return 'custom';
  }
}

function localActiveProjectName(): string | null {
  try {
    return getActiveProject().name;
  } catch {
    return null;
  }
}

/** Real setTimeout sleep that resolves early on abort. */
export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** HarmonyAuth built the way the CLI builds it (src/cli/auth.ts): active project, else env token. */
export function makeCliAuth(): HarmonyAuth {
  let project: ProjectConfig;
  let usedFallback = false;
  try {
    project = getActiveProject();
  } catch (configErr) {
    const token = harmonyEnv('HARMONY_API_TOKEN');
    if (!token) throw configErr;
    project = { name: '(env token)', token };
    usedFallback = true;
  }
  const target = resolveSupabaseTarget({ flags: {}, project: usedFallback ? undefined : project });
  return new HarmonyAuth(project.token, target.url, target.anonKey);
}

function defaultDeps(): WatchCliDeps {
  return {
    makeAuth: makeCliAuth,
    makeClient: (auth, onHealth) => createGuardedClient(auth, onHealth),
    makeReader: (client, projectId) => createBoardReader(client, projectId),
    startHints: (client, auth, projectId, pollMs, log) => {
      // Wired exactly as the daemon wires it (src/bin/daemon.ts). A channel that never subscribes
      // costs nothing: its `next()` never resolves and the poll carries on.
      let realChannel: ReturnType<typeof client.channel> | null = null;
      const sub = startHintSubscription({
        createChannel: (topic) => {
          realChannel = client.channel(topic, { config: { private: true } });
          return realChannel as unknown as HintChannelLike;
        },
        removeChannel: () => (realChannel ? client.removeChannel(realChannel) : Promise.resolve()),
        projectId,
        // Not a lease holder: a unique value so no hint is dropped as "our own write".
        leaseHolder: `watch:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
        debounceMs: 1_000,
        startTimeout: (ms, fn) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        },
        log,
        forceRefresh: () => auth.forceRefresh(),
        setAuth: () => client.realtime.setAuth(),
        pollMs,
      });
      return {
        source: sub.source,
        isDead: () => sub.isDead(),
        close: async () => {
          await sub.close();
          try {
            client.realtime.disconnect();
          } catch {
            // already closed
          }
        },
      };
    },
    installGuards: (onHealth) => installProcessGuards(onHealth),
    resolveTarget: resolveBoardTarget,
    activeProjectName: localActiveProjectName,
    now: () => Date.now(),
    sleep: realSleep,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    onSignal: (handler) => {
      const onInt = () => handler('SIGINT');
      const onTerm = () => handler('SIGTERM');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      return () => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
      };
    },
  };
}

function isScopeError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'ScopeError';
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatAge(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

export function formatEvent(e: WatchEvent): string {
  if (e.event === 'start') return `${e.ts} start ${e.detail ?? ''}`;
  if (e.event === 'health') {
    return `${e.ts} health ${e.status ?? ''}${e.detail ? `: ${e.detail}` : ''}${e.since && e.status !== 'recovered' ? ` (since ${e.since})` : ''}`;
  }
  const parts = [e.ts, e.event + (e.reminder ? ` (reminder ${e.reminder})` : ''), `[${e.owner}]`, e.key ?? ''];
  if (e.state) parts.push(e.state);
  if (e.reason) parts.push(e.reason);
  if (e.waiting_on && e.event === 'waiting') parts.push(`waiting_on=${JSON.stringify(e.waiting_on)}`);
  return `${parts.join(' ')}${e.title ? ` — ${e.title}` : ''}`;
}

export function formatCurrentRow(r: CurrentRow): string {
  const head = `${r.key} ${r.state ?? '?'}`;
  const tail = r.title ? ` — ${r.title}` : '';
  if (!r.waiting) {
    const w = r.waiting_on ? ` waiting_on=${JSON.stringify(r.waiting_on)}` : '';
    return `${head}: nothing waiting${w}${tail}`;
  }
  return `${head}: ${r.waiting}${r.reason ? ` (${r.reason})` : ''} on ${r.on} for ${formatAge(r.age_s)}${tail}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface WatchArgs {
  scope: WatchScope;
  mode: WatchMode;
  seat: string | null;
  remindMs: number | null;
  maxWaitMs: number | null;
  json: boolean;
}

export class UsageError extends Error {}

export function parseWatchArgs(keys: string[], opts: Record<string, unknown>, json: boolean): WatchArgs {
  const scopes: WatchScope[] = [];
  if (keys.length > 0) scopes.push({ kind: 'keys', keys });
  if (typeof opts.milestone === 'string') scopes.push({ kind: 'milestone', id: opts.milestone });
  if (opts.conductions === true) scopes.push({ kind: 'conductions' });
  if (scopes.length !== 1) throw new UsageError('give exactly one scope: ticket keys, --milestone <id> or --conductions');
  for (const k of keys) {
    if (!/^(?:[A-Za-z][A-Za-z0-9]*-)?\d+$/.test(k)) throw new UsageError(`not a ticket key: ${k}`);
  }
  const modes: WatchMode[] = [];
  if (opts.untilEvent === true) modes.push('until-event');
  if (opts.follow === true) modes.push('follow');
  if (opts.once === true) modes.push('once');
  if (modes.length > 1) throw new UsageError('give at most one of --until-event, --follow, --once');
  const mode = modes[0] ?? 'once';
  const seat = typeof opts.seat === 'string' ? opts.seat : null;
  if (seat !== null && !isSafeName(seat)) throw new UsageError(`invalid seat name ${JSON.stringify(seat)}: only [A-Za-z0-9._-]`);
  if (mode !== 'once' && seat === null) throw new UsageError(`--${mode} needs --seat <name>`);
  let remindMs: number | null = null;
  if (typeof opts.remind === 'string') {
    remindMs = parseDuration(opts.remind);
    if (remindMs === null) throw new UsageError(`bad --remind ${JSON.stringify(opts.remind)}: use a duration like 20m, 1h, 90s`);
  }
  let maxWaitMs: number | null = null;
  if (typeof opts.maxWait === 'string') {
    maxWaitMs = parseDuration(opts.maxWait);
    if (maxWaitMs === null) throw new UsageError(`bad --max-wait ${JSON.stringify(opts.maxWait)}: use a duration like 20m, 1h, 90s`);
    if (mode !== 'until-event') throw new UsageError('--max-wait only applies to --until-event');
  }
  try {
    scopeSlug(scopes[0]);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return { scope: scopes[0], mode, seat, remindMs, maxWaitMs, json };
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

export async function runWatchCommand(args: WatchArgs, deps: WatchCliDeps): Promise<number> {
  const homeOpts = deps.home ? { home: deps.home } : {};
  const print = (e: WatchEvent) => deps.out(args.json ? JSON.stringify(e) : formatEvent(e));
  const startupHealth: WatchEvent[] = [];

  // Seat profile.
  let profile: SeatProfile | null = null;
  if (args.seat) {
    const p = readSeatProfile(args.seat, homeOpts);
    if (p.status === 'ok') profile = p.value;
    else {
      startupHealth.push(
        healthEvent(deps.now(), 'warning', null, {
          detail:
            p.status === 'absent'
              ? `no seat profile at ${p.path}; every event is treated as seat-owned`
              : `seat profile ${p.path} is malformed (${p.error}); every event is treated as seat-owned`,
        }),
      );
    }
  }
  for (const h of startupHealth) print(h);

  let auth: WatchAuth;
  try {
    auth = deps.makeAuth();
  } catch (e) {
    deps.err(`harmony watch: ${safeErrorMessage(e)}`);
    return 2;
  }
  let supabaseUrl = '';
  try {
    supabaseUrl = auth.getSupabaseUrl();
  } catch {
    // an auth without a URL: the target reads as custom
  }
  const target: BoardTarget = await (deps.resolveTarget ?? resolveBoardTarget)(supabaseUrl);

  const abort = new AbortController();
  let stoppedBy: string | null = null;
  const offSignal = deps.onSignal((sig) => {
    stoppedBy = sig;
    abort.abort();
  });
  const disposeGuards = deps.installGuards((h) =>
    print(healthEvent(deps.now(), 'warning', profile, { detail: `${h.kind}: ${safeErrorMessage(h.error)}` })),
  );

  let hints: WatchHints | null = null;
  let lockTaken = false;
  let projectKey: string | null = null;
  try {
    // Startup: a rejected token is fatal; a network failure is not.
    const reported = new Set<string>();
    const guardHealth = (h: GuardHealth) => {
      if (reported.has(h.kind)) return;
      reported.add(h.kind);
      deps.err(`harmony watch: token refresh failed (${h.kind}): ${safeErrorMessage(h.error)}`);
    };
    let offlineShown = false;
    let fatal: string | null = null;
    let bootProject: ProjectInfo | null = null;
    const boot = await retryWithBackoff(
      async () => {
        await auth.getAccessToken();
        const client = deps.makeClient(auth, guardHealth);
        const projectId = auth.getProjectId();
        const reader = deps.makeReader(client, projectId);
        const project = await reader.projectInfo();
        bootProject = project;
        // Resolve the scope once now, so a scope that cannot resolve (a foreign key, a milestone
        // not in this project) is fatal before anything else, and the start line can count it.
        const milestone: MilestoneInfo | null = args.scope.kind === 'milestone' ? await reader.resolveMilestone(args.scope.id) : null;
        const ids = await reader.resolveScope(args.scope);
        return { client, projectId, reader, key: project.key, project, milestone, ids };
      },
      {
        now: deps.now,
        sleep: deps.sleep,
        signal: abort.signal,
        onFailure: (err, attempt) => {
          if (isScopeError(err)) {
            const p = bootProject as ProjectInfo | null;
            fatal = `${safeErrorMessage(err)}; the CLI's active project is ${p ? `${p.name} (${p.key})` : 'unknown'} on ${target} (check \`harmony project info\`, change it with \`harmony project switch <name>\`)`;
            return 'stop';
          }
          if (isAuthError(err)) {
            fatal = `token rejected: ${safeErrorMessage(err)}`;
            return 'stop';
          }
          if (!offlineShown) {
            offlineShown = true;
            print(healthEvent(deps.now(), 'offline', profile, { since: new Date(deps.now()).toISOString(), detail: safeErrorMessage(err) }));
          }
          if (args.mode === 'once' && attempt >= ONCE_MAX_ATTEMPTS) return 'stop';
          return 'retry';
        },
      },
    );
    if (!boot.ok) {
      if (fatal) {
        deps.err(`harmony watch: ${fatal}`);
        return 2;
      }
      if (stoppedBy) return 0;
      return 3;
    }
    if (offlineShown) print(healthEvent(deps.now(), 'recovered', profile, { detail: 'startup' }));
    const { client, reader, projectId, project, milestone } = boot.value;
    projectKey = boot.value.key;
    const slug = scopeSlug(args.scope);
    const boardText = `${project.name} (${project.key}) on ${target}`;

    // The seat profile names the board the seat drives; the CLI must be pointed at that board.
    if (profile?.project && profile.project.toUpperCase() !== project.key.toUpperCase()) {
      deps.err(
        `harmony watch: seat profile ${args.seat} names project ${profile.project}, but the CLI's active project is ${boardText}; ` +
          'point the CLI at the board the seat drives (`harmony project info`, `harmony project switch <name>`) or fix the profile',
      );
      return 2;
    }

    // Lock.
    if (args.mode !== 'once' && args.seat) {
      const res = acquireLock(projectKey, args.seat, args.scope, args.mode, homeOpts);
      if (res.status === 'held') {
        deps.err(
          `harmony watch: another watch holds ${res.path} (pid ${res.holder.pid} on ${res.holder.hostname}, ${res.holder.mode} since ${res.holder.started_at})`,
        );
        return 2;
      }
      lockTaken = true;
    }

    // Cursor.
    let cursor: WatchCursor | null = null;
    if (args.seat) {
      const c = readCursor(projectKey, args.seat, homeOpts);
      if (c.status === 'ok') cursor = c.value;
      else if (c.status === 'malformed') {
        print(healthEvent(deps.now(), 'warning', profile, { detail: `cursor ${c.path} is malformed (${c.error}); starting fresh` }));
      }
    }

    // Every run states what it watches (an info event; never a wake).
    const startScope: NonNullable<WatchEvent['scope']> =
      args.scope.kind === 'milestone'
        ? { kind: 'milestone', id: milestone?.id ?? args.scope.id, name: milestone?.name ?? null }
        : args.scope.kind === 'keys'
          ? { kind: 'keys', keys: [...args.scope.keys] }
          : { kind: 'conductions' };
    print(startEvent(deps.now(), { name: project.name, key: project.key }, target, startScope, boot.value.ids.length, cursor?.seq ?? 0));

    const pollMs = deps.pollMs ?? 30_000;
    if (args.mode !== 'once') {
      try {
        hints = deps.startHints(client, auth, projectId, pollMs, (l) => deps.err(`harmony watch: ${l}`));
      } catch (e) {
        deps.err(`harmony watch: realtime hints unavailable (${safeErrorMessage(e)})`);
        hints = null;
      }
    }

    const seat = args.seat;
    const pk = projectKey;
    const result = await runWatch({
      now: deps.now,
      sleep: deps.sleep,
      reader,
      scope: args.scope,
      hint: hints ? hints.source : null,
      hintDead: hints ? () => hints!.isDead() : undefined,
      emit: print,
      cursor,
      writeCursor: seat ? (c) => writeCursor(pk, seat, c, homeOpts) : undefined,
      writeHeartbeat: seat && args.mode !== 'once' ? (hb: Heartbeat) => writeHeartbeat(pk, seat, hb, homeOpts) : undefined,
      markerScan:
        args.scope.kind === 'milestone'
          ? async (ids) => openSeatStarts(await reader.listMarkerComments(ids), profile?.session_id ?? null)
          : undefined,
      printCurrent: (rows) => {
        for (const r of rows) deps.out(args.json ? JSON.stringify({ event: 'current', ...r }) : formatCurrentRow(r));
        if (!args.json && !rows.some((r) => r.waiting)) {
          deps.out(`nothing waiting (${rows.length} ticket${rows.length === 1 ? '' : 's'} watched in ${pk} on ${target})`);
        }
      },
      log: deps.err,
      signal: abort.signal,
      mode: args.mode,
      options: {
        seat: seat ?? 'once',
        projectKey: pk,
        scopeSlug: slug,
        profile,
        pollMs,
        hintDelayMs: deps.hintDelayMs,
        settleMs: deps.settleMs,
        maxWaitMs: args.maxWaitMs,
        remindMs: args.remindMs ?? (profile?.remind ? (parseDuration(profile.remind) ?? undefined) : undefined),
      },
    });
    if (result.exitCode === 2) deps.err(`harmony watch: ${result.detail ?? 'fatal'}`);
    if (result.reason === 'aborted') return stoppedBy === 'SIGTERM' ? 143 : 130;
    return result.exitCode;
  } finally {
    disposeGuards();
    offSignal();
    if (hints) {
      try {
        await hints.close();
      } catch {
        // best effort
      }
    }
    if (lockTaken && projectKey && args.seat) {
      try {
        releaseLock(projectKey, args.seat, args.scope, homeOpts);
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// watch status
// ---------------------------------------------------------------------------

export function runWatchStatus(
  seat: string | null,
  json: boolean,
  deps: Pick<WatchCliDeps, 'now' | 'out' | 'err' | 'home' | 'activeProjectName'>,
): number {
  if (!seat) {
    deps.err('harmony watch status: --seat <name> is required');
    return 2;
  }
  if (!isSafeName(seat)) {
    deps.err(`harmony watch status: invalid seat name ${JSON.stringify(seat)}`);
    return 2;
  }
  const homeOpts = deps.home ? { home: deps.home } : {};
  const profile = readSeatProfile(seat, homeOpts);
  if (profile.status === 'ok' && profile.value.project) {
    // The CLI's local config stores a project's name, token and URL, never its key, so the
    // profile's `project:` can only be checked against the board. Say so; never go to the network.
    const active = (deps.activeProjectName ?? localActiveProjectName)();
    deps.err(
      `harmony watch status: not checking the profile's project ${profile.value.project} against the CLI's active project` +
        `${active ? ` "${active}"` : ''}: its key is known only from the board. \`harmony watch\` checks it at start (exit 2 on a mismatch).`,
    );
  }
  const projects =
    profile.status === 'ok' && profile.value.project && isSafeName(profile.value.project) ? [profile.value.project] : listWatchProjects(homeOpts);

  let best: { project: string; hb: Heartbeat } | null = null;
  for (const p of projects) {
    const r = readHeartbeat(p, seat, homeOpts);
    if (r.status !== 'ok') continue;
    const at = Date.parse(r.value.last_fetch_at ?? r.value.started_at);
    const bestAt = best ? Date.parse(best.hb.last_fetch_at ?? best.hb.started_at) : -Infinity;
    if (!best || at > bestAt) best = { project: p, hb: r.value };
  }
  const now = deps.now();
  if (!best) {
    if (json) deps.out(JSON.stringify({ seat, status: 'none' }));
    else deps.out(`watch ${seat}: none (no heartbeat)`);
    return 1;
  }
  const hb = best.hb;
  const stale = isHeartbeatStale(hb, now);
  const ref = Date.parse(hb.last_fetch_at ?? hb.started_at);
  const ageS = Number.isNaN(ref) ? null : Math.max(0, Math.round((now - ref) / 1000));
  const locks = listLocks(best.project, seat, homeOpts)
    .filter((l) => l.status === 'ok')
    .map((l) => (l as { value: { pid: number; hostname: string; scope: string; mode: string } }).value);
  const status = stale ? 'stale' : 'alive';
  // AC5: list what is waiting on a human (seat-owned and founder-held alike) with its age, from the
  // on-disk cursor — offline, no board read. Founder-held items appear here but never wake the seat.
  const cur = readCursor(best.project, seat, homeOpts);
  const profileValue = profile.status === 'ok' ? profile.value : null;
  const waiting =
    cur.status === 'ok'
      ? Object.values(cur.value.tickets)
          .filter((t) => t.awaiting)
          .map((t) => {
            const since = Date.parse(t.first_seen);
            return {
              key: t.key,
              reason: t.reason,
              on: ownerFor(t.reason === 'elicitation-round' ? 'question' : 'ready', t.reason, profileValue),
              since: t.first_seen,
              age_s: Number.isNaN(since) ? null : Math.max(0, Math.round((now - since) / 1000)),
            };
          })
          .sort((a, b) => a.key.localeCompare(b.key))
      : [];
  if (json) {
    deps.out(
      JSON.stringify({
        seat,
        project: best.project,
        status,
        health: hb.health,
        pid: hb.pid,
        scope: hb.scope,
        mode: hb.mode,
        last_fetch_at: hb.last_fetch_at,
        last_ok_at: hb.last_ok_at,
        last_fetch_age_s: ageS,
        locks,
        waiting,
      }),
    );
  } else {
    const lockText = locks.length ? `; lock: ${locks.map((l) => `${l.scope} pid ${l.pid}@${l.hostname}`).join(', ')}` : '; no lock';
    deps.out(
      `watch ${seat} (${best.project}): ${status}, health ${hb.health}, last fetch ${ageS === null ? '?' : formatAge(ageS)} ago, pid ${hb.pid}, ${hb.mode} ${hb.scope}${lockText}`,
    );
    for (const w of waiting) {
      deps.out(`  waiting on ${w.on}: ${w.key} ${w.reason ?? ''} for ${w.age_s === null ? '?' : formatAge(w.age_s)}`);
    }
  }
  return stale ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWatchCommands(program: Command, override: Partial<WatchCliDeps> = {}): void {
  const deps = (): WatchCliDeps => ({ ...defaultDeps(), ...override });
  const watch = program
    .command('watch')
    .description('Watch tickets for events a seat must act on (default mode: --once)')
    .argument('[keys...]', 'ticket keys (B-1422 or 1422)')
    .option('--milestone <id>', 'watch the non-archived tickets of a milestone (id or name)')
    .option('--conductions', 'watch the tickets with a live conduction')
    .option('--seat <name>', 'seat name (keys the profile, cursor, heartbeat and lock)')
    .option('--until-event', 'exit 0 at the first seat-owned event (3 on --max-wait)')
    .option('--follow', 'stream every event until stopped')
    .option('--once', 'print what is waiting now and exit (the default)')
    .option('--remind <dur>', 're-raise a seat-owned item still open after this long (default 20m)')
    .option('--max-wait <dur>', 'with --until-event: give up (exit 3) after this long')
    .action(async (keys: string[], opts: Record<string, unknown>) => {
      const d = deps();
      const json = program.opts().json === true || opts.json === true;
      let args: WatchArgs;
      try {
        args = parseWatchArgs(keys ?? [], opts, json);
      } catch (e) {
        d.err(`harmony watch: ${(e as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const code = await runWatchCommand(args, d);
      process.exitCode = code;
      if (args.mode !== 'once') {
        // The loop has shut down and released its lock; do not let a lingering socket keep the
        // process alive past this point.
        setTimeout(() => process.exit(code), 2_000).unref();
      }
    });

  watch
    .command('status')
    .description("Is this seat's watch alive? (exit 0 alive, 1 none or stale)")
    .option('--seat <name>', 'seat name')
    .action((opts: { seat?: string }) => {
      const d = deps();
      // Commander hands `--seat` to the parent `watch` command; accept it from either.
      const seat = opts.seat ?? (watch.opts().seat as string | undefined) ?? null;
      const json = program.opts().json === true;
      process.exitCode = runWatchStatus(seat, json, d);
    });
}
