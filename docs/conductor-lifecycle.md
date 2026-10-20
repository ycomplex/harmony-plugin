# Conductor lifecycle (B-1171)

`harmony conductor start | stop | restart | status` run and update this project's **conductor** on the machine
you are logged in to. (The conductor is the long-running process that watches the board and launches workers;
internally it is `src/bin/daemon.ts`, bundled as `dist/bin/daemon.js`, and internal paths and variable names
keep "daemon".) Configuration is a separate subject: [`docs/conductor-config.md`](conductor-config.md).

The code is `src/cli/commands/conductor-lifecycle.ts` (the four commands), `conductor-preflight.ts` (the
shared pre-flight), `src/daemon/supervisor-control.ts` (launchd / systemd commands and templates),
`src/daemon/conductor-process.ts` (which process is *this* project's conductor) and
`container/conductor-launch.sh` (the launcher).

## Semantics (defined once)

| Word | Means |
|---|---|
| **stop** | **No new launches.** Running legs keep running as their own jobs (Cloud Run executions, k8s Jobs); they are not killed. The next `start` adopts them. The supervisor is kept from restarting the conductor. |
| **restart** | **stop, then start, then adopt.** Adoption is confirmed from the *board*: every conduction the old process held is leased by the new process with a fresh heartbeat. |
| **update** | **restart onto the channel's latest version.** Every restart path first pulls the channel named in the config file (`git pull --ff-only origin <channel>` in the host's plugin checkout) and reports the plugin version before and after. |

Stopping is safe for legs because the conductor's SIGTERM handling already works that way: it stops stamping
heartbeats, writes a clean-shutdown marker on the leases it holds (so a same-host successor takes them
immediately instead of waiting out the stale window) and exits 0.

## Commands

### `harmony conductor status [--json]`

Where the conductor runs (host, pid), its profile, plugin version and channel, the supervisor kind, the last
heartbeat, and the legs running under it (read from the board by this host and pid). It also says whether
every lease on this host is held by the running process with a fresh heartbeat, or lists the ones that are
**not yet adopted**.

With no conductor on this machine it prints `No conductor is running here. Status for a conductor elsewhere
arrives with the registry.` and exits 0, followed by any legs still running under the stopped conductor.
`--json` prints the same facts as one object (`state`, `host`, `pids`, `profile`, `plugin_version`,
`supervisor`, `last_heartbeat_at`, `legs`, `not_adopted`, `adoption_complete`).

### `harmony conductor start [--local | --at-boot | --remote] [--profile P] [--config C]`

Refuses (exit 1, naming host and pid, starting nothing) if a conductor for this project already runs on this
machine. Otherwise runs the pre-flight and installs a supervisor job so the conductor survives a reboot.

- `--local` (the default): macOS installs a **LaunchAgent** under `~/Library/LaunchAgents` and bootstraps it
  into `gui/$UID`; Linux installs a **systemd user unit** under `~/.config/systemd/user` and runs
  `systemctl --user daemon-reload && systemctl --user enable --now`. Pre-flight warns when macOS automatic
  login is off (a LaunchAgent starts at *login*) or Linux lingering is off (`sudo loginctl enable-linger
  $USER`).
- `--at-boot` (macOS only, needs `sudo` once): installs a **LaunchDaemon** in `/Library/LaunchDaemons` with a
  `UserName` key, so it starts at boot as that user with that user's `HOME`, no login needed.
- `--remote`: exits non-zero ("not available yet"); remote conductors arrive with the registry. Nothing is
  started locally.

Both supervisor jobs run `container/conductor-launch.sh`, which loads `~/.harmony/conductor.env` and `exec`s
`node <plugin>/dist/bin/daemon.js`. The job is rendered from `container/launchd/*.plist.template` or
`container/systemd/*.service.template`; it carries no credential.

### `harmony conductor stop`

Stops the conductor as the supervisor requires, so it is not brought back:

| Supervisor | Stop |
|---|---|
| `launchd-agent` | `launchctl bootout gui/$UID/<label>` (unloads the job, so `KeepAlive` cannot restart it) |
| `launchd-daemon` | `sudo launchctl bootout system/<label>` |
| `systemd-user` | `systemctl --user stop harmony-conductor.service` |
| `none` | SIGTERM |

It waits up to 60 s for the process to exit, then lists the legs still running. `status` and `stop` handle
**both** launchd domains (`gui/$UID` and `system`).

### `harmony conductor restart [--profile P] [--config C] [--dry-run] [--force]`

1. **Pre-flight** (below), before any signal.
2. Records the conductions the old process holds (from the board).
3. **In-flight guard.** Refuses with exit 3 while a leg is running on the backend the target profile does *not*
   use (a k8s Job when leaving gke; a Cloud Run execution when leaving cloud), naming each by ticket and
   conduction id. `--force` skips it: a last resort, because the new conductor reaps adopted leases with its own
   profile's reap script, which cannot see a leg on the other backend, so a leg can run twice. When the
   running profile did not visibly change and the other backend's tool or variables are absent on this
   machine, the guard is skipped with a note.
4. **Update.** `git pull --ff-only origin <channel>`; prints `plugin A -> B`. A failed pull leaves the running
   conductor alone.
5. **Restart.** launchd: `launchctl kickstart -k <domain>/<label>`; systemd: `systemctl --user restart`;
   unsupervised: SIGTERM, wait up to 60 s, start `container/conductor-launch.sh` detached under `nohup` (with the
   old process's own `--config` / `--profile`).
6. **Adopt.** Within 3 minutes every held conduction is leased by the new process with a heartbeat under 2
   minutes old, or has legitimately left the active state. The conductor's log is never consulted.

A supervised conductor takes its profile from the config files, so `--profile` is refused for it (exit 2);
change `profile` in the config and run `restart`. `--dry-run` runs steps 1-3 and prints the rest.

Exit codes, identical to `container/gke/switch-daemon-profile.sh`: **0** ok, **1** failure, **2** usage,
**3** a leg is in flight on another backend, **4** adoption not confirmed. Timing knobs are the script's:
`HARMONY_SWITCH_TIMEOUT_S` (180), `_POLL_S` (5), `_STOP_TIMEOUT_S` (60), `_FRESH_S` (120).

## Pre-flight (start and restart)

Read-only, run before anything is changed. A failed check exits non-zero **naming the check**; the running
conductor and its leases are untouched. Credentials are reported by name, never by value.

| Check | What it proves |
|---|---|
| `env-file` | `~/.harmony/conductor.env` (else the legacy `daemon.env`) sources cleanly |
| `config` | `harmony conductor config doctor` reports no issue |
| `tool:git`, `tool:node` | always; plus `tool:kubectl` (gke) or `tool:gcloud` (cloud) |
| `cred:HARMONY_API_TOKEN` | present |
| `cred:board` | the board is readable with that token |
| `cred:github-app-key` | `HARMONY_APP_PRIVATE_KEY_PATH` names a readable file (or `HARMONY_APP_PRIVATE_KEY` is set) |
| `reach:gke-base-secret` / `reach:cloud-run-job` | `kubectl get secret <base secret>` / `gcloud run jobs describe` succeeds |
| `channel-branch` | restart only: the plugin checkout is on the config's `channel` branch, so the fast-forward pull means something |

## Which process is "this project's conductor"

`node <plugin checkout>/dist/bin/daemon.js ...`, matched on the **full command line**: the script must be this
checkout's `dist/bin/daemon.js`, and a process started with a different `--config` is excluded. It does not
match the ticket-disk sweep job, a `harmony` CLI invocation (including `harmony conductor stop`), the launcher
script (which `exec`s into node) or another checkout's daemon. A checkout path containing spaces is not
supported by the matcher.

## The environment file

`container/conductor-launch.sh` is the one place `~/.harmony/conductor.env` is loaded, for launchd, systemd and
`nohup` starts alike (`HARMONY_HOME` replaces `~/.harmony`). If only the old `~/.harmony/daemon.env` exists it is
loaded and one line is printed: `conductor-launch: reading ~/.harmony/daemon.env — rename it to
~/.harmony/conductor.env`. `container/gke/switch-daemon-profile.sh` follows the same preference. The conductor's
output goes to `~/.harmony/conductor.log` for every start these commands make.

## Adopting a nohup conductor into launchd (the Mac mini sequence)

The conductor on the Mac mini was started by hand under `nohup`. Moving it under launchd takes three commands,
and no leg is interrupted: the legs are Cloud Run executions / k8s Jobs, and the new process adopts their leases.

**1. `harmony conductor stop`**: SIGTERM to the nohup conductor (supervisor `none`).

```
Stopping the conductor (pid 4242; supervisor none (unsupervised)).
Running legs keep running as their own jobs; the next start adopts them.
  SIGTERM 4242
Conductor stopped.
2 leg(s) still running as their own jobs; the next `harmony conductor start` adopts them:
  - B-1001  conduction c-111
  - B-1002  conduction c-222
```

**2. `harmony conductor start --local`**: pre-flight, then the LaunchAgent is installed and bootstrapped.

```
Pre-flight
  [ok  ] env-file: loaded /Users/op/.harmony/conductor.env (values not shown)
  [ok  ] config: harmony conductor config doctor: ok
  [ok  ] tool:git: git found on PATH
  ...
  [ok  ] cred:board: the board is readable with HARMONY_API_TOKEN
Installed the LaunchAgent /Users/op/Library/LaunchAgents/com.ycomplex.harmony-daemon.plist.
  $ launchctl bootstrap gui/501 /Users/op/Library/LaunchAgents/com.ycomplex.harmony-daemon.plist

Conductor started: host macmini, pid 9001, supervisor launchd-agent, plugin 0.15.80, log /Users/op/.harmony/conductor.log.
It survives a reboot. Run `harmony conductor status` to confirm it holds its leases with a fresh heartbeat.
```

**3. `harmony conductor status`**: confirms every lease is held by the new process with a fresh heartbeat.

```
Conductor: running
  host:            macmini
  pid:             9001
  profile:         gke
  plugin version:  0.15.80 (channel staging)
  supervisor:      launchd-agent (gui/501/com.ycomplex.harmony-daemon)
  last heartbeat:  2026-10-20T12:00:05.000Z (4s ago)

Legs running under this conductor: 2
  - B-1001  conduction c-111  heartbeat 4s ago
  - B-1002  conduction c-222  heartbeat 4s ago
Adoption: every lease on this host is held by pid 9001 with a fresh heartbeat.
```

If a lease is still held by the old pid, `status` prints `NOT YET ADOPTED: n lease(s) ...` and
`adoption_complete` is false in `--json`; wait a poll interval and run it again. A macOS host that must start
the conductor before anyone logs in uses `harmony conductor start --at-boot` instead of `--local` in step 2.
