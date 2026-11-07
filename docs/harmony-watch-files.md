# Harmony watch files (B-1422)

> **Living · contract** · B-1422 owns the format. B-1423's seat hooks read it. Change this doc and
> `src/watch/seat-files.ts` together.

A seat and its `harmony watch` share four small files. This doc says where they live, what is in
them, and who writes them.

## Location

All four live under `${HARMONY_HOME:-$HOME/.harmony}` (called `<home>` below). An empty
`HARMONY_HOME` counts as unset.

| File | Path | Format | Writer |
|---|---|---|---|
| Seat profile | `<home>/seats/<name>.yml` | YAML | the seat, from its grant |
| Cursor | `<home>/watch/<project-key>/<seat>.json` | JSON | the `harmony watch` process |
| Heartbeat | `<home>/watch/<project-key>/<seat>.heartbeat.json` | JSON | the `harmony watch` process |
| Lock | `<home>/watch/<project-key>/<seat>.<scope-slug>.lock` | JSON | the `harmony watch` process |

Seat names and project keys must match `[A-Za-z0-9._-]+` (and not be `.` or `..`). Anything else
is refused, so a name cannot escape its directory. The path helpers throw on a bad name. The
readers return `malformed` instead.

### Scope slug

The lock name carries a slug of the watch scope. It is lowercase `[a-z0-9-]` only and deterministic.

- milestone scope: `milestone-<id>` (for example `milestone-v1-13`)
- conductions scope: `conductions`
- ticket keys scope: `keys-<keys, lowercased, sorted, joined by '-'>` (for example `keys-b-1-b-20-b-3`)

A slug longer than 80 characters is cut short and ends in `-<first 8 hex chars of sha256(full slug)>`,
so two long scopes still get different slugs.

## Atomic writes

Every writer uses the same rule: create the directory, write `<path>.tmp-<pid>-<random>`, fsync it,
then rename it over `<path>`. A reader therefore sees the old file or the new one, never half a file.
The lock is the exception: see "Lock" below.

All JSON files carry `"schema": 1`. A reader treats any other value as `malformed`.

## Seat profile

The seat writes this from its grant when it starts. Unknown extra keys are ignored. Missing keys
read as `null` (or `[]` for lists).

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string or null | The seat's Claude Code session id. Always a plain top-level line `session_id: <id>`, so B-1423 can find the seat with `grep 'session_id: <id>' ~/.harmony/seats/*.yml`. |
| `project` | string or null | Project key, for example `B`. |
| `milestone` | string or null | Milestone the seat is driving. |
| `anchor` | string or null | Ticket key that carries the seat-start and stand-down markers. |
| `owns` | string[] | What the seat handles itself. |
| `held_for_founder` | string[] | What the seat holds for the founder. |
| `remind` | duration or null | How often to re-raise an item still waiting, for example `20m`, `1h`, `90s`. |

### Vocabulary for `owns` and `held_for_founder`

Each entry is one of:

- an exact `awaiting_human_reason` value, for example `plan-draft`;
- an event name: `ready`, `question`, `park`, `dirty-exit`, `waiting`, `acted`, `state`, `added`,
  `removed`, `idle`, `health`;
- a gate alias:

| Alias | Means |
|---|---|
| `clarify` | `clarification-draft` |
| `decompose` | `decomposition-proposal` |
| `design` | `design-decision-draft` |
| `plan` | `plan-draft` |
| `release` | `release-decision-pending` |
| `verify` | `verification-ack-pending` |

A reason the profile does not list wakes the seat.

### Seat-start and stand-down markers

The seat posts a comment on the profile's `anchor` ticket when it starts and when it stands down:

```
SEAT-START v1 seat=<name> milestone=<id> session=<id>
SEAT-STANDDOWN v1 seat=<name> milestone=<id> session=<id>
```

### Example

```yaml
session_id: 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b
project: B
milestone: v1.13
anchor: B-1422
owns:
  - plan
  - release
  - ready
held_for_founder:
  - verify
  - design-decision-draft
remind: 20m
```

## Heartbeat

The watch rewrites this after every fetch.

| Field | Type | Meaning |
|---|---|---|
| `schema` | `1` | Format version. |
| `pid` | integer | The watch process id. |
| `seat` | string | Seat name. |
| `scope` | string | Scope slug. |
| `mode` | `until-event` / `follow` / `once` | How the watch was started. |
| `poll_interval_s` | number | Seconds between fetches. |
| `started_at` | ISO timestamp | When the watch started. |
| `last_fetch_at` | ISO timestamp or null | Last fetch attempt. |
| `last_ok_at` | ISO timestamp or null | Last successful fetch. |
| `health` | `ok` / `degraded` / `offline` / `auth-failed` | Current health. |
| `seq` | integer >= 0 | Increments on every write. |

### Staleness rule

A heartbeat is stale when `now - (last_fetch_at ?? started_at)` is more than
`max(3 * poll_interval_s * 1000, 5 * 60_000)` milliseconds. That is three poll intervals, with a
five-minute minimum. An unparseable timestamp counts as stale.

### Example

```json
{
  "schema": 1,
  "pid": 48211,
  "seat": "orch",
  "scope": "milestone-v1-13",
  "mode": "follow",
  "poll_interval_s": 30,
  "started_at": "2026-11-07T10:00:00.000Z",
  "last_fetch_at": "2026-11-07T10:14:30.000Z",
  "last_ok_at": "2026-11-07T10:14:30.000Z",
  "health": "ok",
  "seq": 29
}
```

## Lock

One watch per (project, seat, scope) may run at a time.

- `--until-event` and `--follow` take the lock. `--once` and `status` never do.
- A second watch that finds the lock held exits with code 2 and names the holder's pid.
- The lock is created exclusively: its body is written and fsynced to a tmp file, then hard-linked to
  the lock path. The link fails if the lock already exists, as `open(..., 'wx')` would, and a reader
  never sees an empty lock.
- A lock is held when it was written on this host and its pid is alive. The pid check is
  `process.kill(pid, 0)`: `EPERM` means alive, `ESRCH` means dead.
- A lock written on another host always counts as held, because its pid cannot be checked from
  here. It is never taken over automatically.
- A lock that is not held (dead pid on this host, or malformed) is taken over: it is removed and the
  create is retried once.
- A watch removes the lock on exit only if the lock still records its own pid.

| Field | Type | Meaning |
|---|---|---|
| `schema` | `1` | Format version. |
| `pid` | integer | Holder's process id. |
| `hostname` | string | Holder's `os.hostname()`. |
| `scope` | string | Scope slug. |
| `mode` | `until-event` / `follow` | How the holder was started. |
| `started_at` | ISO timestamp | When the lock was taken. |

### Example

```json
{
  "schema": 1,
  "pid": 48211,
  "hostname": "founder-mbp",
  "scope": "milestone-v1-13",
  "mode": "follow",
  "started_at": "2026-11-07T10:00:00.000Z"
}
```

## Cursor

The watch's memory of what it has seen and reported, so a restart does not re-report everything.

| Field | Type | Meaning |
|---|---|---|
| `schema` | `1` | Format version. |
| `project` | string | Project key. |
| `seat` | string | Seat name. |
| `seq` | integer >= 0 | Increments on every write. |
| `updated_at` | ISO timestamp | Last write. |
| `tickets` | object | Keyed by task uuid; each value is a ticket entry below. |

Ticket entry:

| Field | Type | Meaning |
|---|---|---|
| `key` | string | Ticket key, for example `B-1422`. |
| `state` | string or null | Board state last seen. |
| `awaiting` | boolean | Whether the ticket was awaiting a human. |
| `reason` | string or null | `awaiting_human_reason` last seen. |
| `ref_id` | string or null | Id of the artefact the reason refers to. |
| `iteration` | integer or null | Gate iteration last seen. |
| `conduction_status` | string or null | Conduction status last seen. |
| `leg_ended_at` | ISO timestamp or null | When the last leg ended. |
| `waiting_on` | any JSON | What the conduction is waiting on, as reported. |
| `first_seen` | ISO timestamp | When the watch first saw the ticket. |
| `last_reported` | ISO timestamp or null | When the watch last reported it to the seat. |
| `reminders` | integer >= 0 | Reminders sent for the current wait. |

### Example

```json
{
  "schema": 1,
  "project": "B",
  "seat": "orch",
  "seq": 3,
  "updated_at": "2026-11-07T10:14:30.000Z",
  "tickets": {
    "7b0c6a8e-0000-4000-8000-000000000001": {
      "key": "B-1422",
      "state": "In Progress",
      "awaiting": true,
      "reason": "plan-draft",
      "ref_id": "c1d2e3f4",
      "iteration": 1,
      "conduction_status": "running",
      "leg_ended_at": "2026-11-07T10:12:00.000Z",
      "waiting_on": null,
      "first_seen": "2026-11-07T10:00:30.000Z",
      "last_reported": "2026-11-07T10:12:30.000Z",
      "reminders": 0
    }
  }
}
```

## Reader module: `src/watch/seat-files.ts`

This is the only code that reads or writes these files. B-1423's seat hooks import it.

Readers never throw. Each returns a `ReadResult<T>`:

```ts
type ReadResult<T> =
  | { status: 'ok'; value: T; path: string }
  | { status: 'absent'; path: string }
  | { status: 'malformed'; path: string; error: string };
```

A hook should fail open on `absent` and `malformed`.

| Export | What it does |
|---|---|
| `harmonyHome(home?)` | Resolves `<home>`. |
| `seatProfilePath`, `watchDir`, `cursorPath`, `heartbeatPath`, `lockPath` | Path helpers; throw on a bad name. |
| `scopeSlug(scope)` | Scope slug; `scope` is `{ kind: 'milestone', id } \| { kind: 'conductions' } \| { kind: 'keys', keys }`. |
| `isSafeName(name)` | The name check. |
| `parseDuration(s)` | `20m` / `1h` / `90s` / `1h30m` to milliseconds, else `null`. |
| `readSeatProfile(name, opts?)` | Reads a seat profile. |
| `readHeartbeat(projectKey, seat, opts?)` | Reads a heartbeat. |
| `readLock(projectKey, seat, scope, opts?)` | Reads a lock. |
| `readCursor(projectKey, seat, opts?)` | Reads a cursor. |
| `isHeartbeatStale(hb, now?)` | The staleness rule above. |
| `isLockHeld(lock, { isPidAlive?, hostname? })` | The held rule above. |
| `writeJsonAtomic(path, value)` | The atomic-write rule. |
| `writeHeartbeat`, `writeCursor` | Validate, then write atomically. |
| `formatSeatProfile`, `writeSeatProfile` | Render and write a profile with `session_id:` first. |
| `acquireLock(projectKey, seat, scope, mode, opts?)` | Returns `{ status: 'acquired', lock }` or `{ status: 'held', holder }`. |
| `releaseLock(projectKey, seat, scope, opts?)` | Removes the lock only if its pid matches. |
| `listWatchProjects(opts?)` | Project keys with a `<home>/watch/<key>/` directory. Never throws. |
| `listLocks(projectKey, seat, opts?)` | Every `<seat>.<scope-slug>.lock` of the seat, as `ReadResult`s. Never throws. |

Every helper takes an optional `{ home }` to override `<home>` (used by tests). The zod schemas
(`HeartbeatSchema`, `WatchLockSchema`, `WatchCursorSchema`, `CursorTicketSchema`) and the types
(`SeatProfile`, `Heartbeat`, `WatchLock`, `WatchCursor`, `CursorTicket`, `WatchScope`) are exported
too.

## The command that writes these files

`harmony watch` (`src/cli/commands/watch.ts`) is the only writer of the cursor, heartbeat and lock.

```
harmony watch [keys...] | --milestone <id|name> | --conductions
              [--seat <name>] [--until-event | --follow | --once]
              [--remind <dur>] [--max-wait <dur>] [--json]
harmony watch status --seat <name>
```

- Exactly one scope. At most one mode; with none, the mode is `--once`.
- `--until-event` and `--follow` need `--seat` and take the lock. `--once` and `status` never lock,
  and `--once` writes neither the cursor nor the heartbeat, so it never takes a seat's events.
- Exit codes: `0` a seat-owned event (`--until-event`) or done; `3` `--max-wait` passed with nothing
  seat-owned, or `--once` could not reach the board; `2` bad arguments, a held lock (the message
  names the holder's pid), a token rejected at startup, or a scope that cannot resolve; `130` / `143`
  stopped by SIGINT / SIGTERM. `status`: `0` alive, `1` none or stale.
- `health` lines are printed as events but never end an `--until-event` wait.
- `status` finds the heartbeat through the profile's `project`, else by scanning `<home>/watch/*/`.
- `status` also lists every ticket the cursor records as waiting on a human, with its reason, who it is
  waiting on (`seat` or `founder`, from the profile) and its age. It reads only local files, so it works offline.
