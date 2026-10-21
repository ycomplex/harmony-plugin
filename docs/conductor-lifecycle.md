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

With no conductor on this machine it prints `No conductor is running here.`, then asks the **registry**
(B-1172) and prints the registered conductor's host (hidden from non-owners), location, profile, plugin
version, start time, last heartbeat, log link and any restart request. If the registry functions are not on
this project's database yet it says so (`registry not deployed on this project`). It exits 0 either way, and
lists any legs still running under a stopped conductor.
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
- `--remote` (B-1173): starts the conductor **in the project's GKE cluster**. It scales the Deployment
  `harmony-conductor` in namespace `harmony-conductor` to 1 replica with **your own kubectl credentials**
  (`--context` from `HARMONY_GKE_CONTEXT`, which the config files derive from `gke.cluster`/`gke.location`;
  else your current context), then polls the registry until the row shows `location: remote`, `state: running`
  (exit 0; exit 4 if not confirmed in `HARMONY_SWITCH_TIMEOUT_S`, default 180s). It refuses, changing nothing, if
  a conductor already runs somewhere else (stop that one first) or the registry is not deployed. Nothing is
  installed on this machine. Mutually exclusive with `--local` and `--at-boot`.

Both supervisor jobs run `container/conductor-launch.sh`, which loads `~/.harmony/conductor.env` and `exec`s
`node <plugin>/dist/bin/daemon.js`. The job is rendered from `container/launchd/*.plist.template` or
`container/systemd/*.service.template`; it carries no credential.

### `harmony conductor stop [--remote]`

`--remote` (B-1173) scales the cluster Deployment to 0 with your own kubectl credentials and reports when the pod
has released the registry row. Running legs are their own Jobs and carry on; the next start adopts them.
Without `--remote` it stops the conductor on this machine, as below.

Stops the conductor as the supervisor requires, so it is not brought back:

| Supervisor | Stop |
|---|---|
| `launchd-agent` | `launchctl bootout gui/$UID/<label>` (unloads the job, so `KeepAlive` cannot restart it) |
| `launchd-daemon` | `sudo launchctl bootout system/<label>` |
| `systemd-user` | `systemctl --user stop harmony-conductor.service` |
| `none` | SIGTERM |

It waits up to 60 s for the process to exit, then lists the legs still running. `status` and `stop` handle
**both** launchd domains (`gui/$UID` and `system`).

### `harmony conductor restart [--profile P] [--config C] [--dry-run] [--force] [--no-pull] [--request ID]`

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

`--no-pull` restarts onto the version already on disk (step 4 is skipped; the registry action `restart`).
`--request ID` is what a conductor passes to the restarter it spawns for a registry request (B-1172): after
the adoption check the request is completed `done`, or `failed` with the reason (a failed pull leaves the old
conductor running, then the request is completed `failed`).

**With no conductor on this machine** (and no supervisor job) `restart` asks the registry instead: it queues an
`update` request (`restart` with `--no-pull`), the conductor picks it up on its next heartbeat (up to 30 s),
and the command polls every 2 s for up to 90 s until the request is done and the registry shows a fresh
heartbeat from a *new* holder. Exit 0 once confirmed, **4** if not confirmed in the budget, **1** with the
reason when refused (no live conductor; a request already pending, naming who and when; only the project
owner may request) or when the registry is not deployed on this project.

## The conductor registry (B-1172)

The conductor registers itself at boot (`conductor_acquire`) and heartbeats the row every `heartbeatMs`
(30 s). A second conductor for the project is refused with `a conductor for this project is already running
on <host> (last heartbeat <N>s ago); refusing to start` (exit 1, no scheduler started). A crash restart on the
same host is not refused for 5 minutes: if the holder is on this host and its pid is dead, the acquire is
retried with the dead-pid takeover. A failed registry call (network, timeout, 5xx, missing function) is never
"lost": the conductor keeps running and launching, logs once per outage and once on recovery. Only a
different holder with a fresh heartbeat makes it stop launching and exit like SIGTERM. A registry that is not
deployed yet is logged once at boot and re-probed every 5 minutes. SIGTERM/SIGINT release the row.

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
| `tool:git`, `tool:node` | always; plus `tool:kubectl` and `tool:gke-gcloud-auth-plugin` (gke) or `tool:gcloud` (cloud). A missing `gke-gcloud-auth-plugin` asks `gcloud info` for the SDK root and, if the plugin is installed there, names the exact `source <sdk_root>/path.zsh.inc` (or `path.bash.inc`) line; see [operator machines](#operator-machines-harmony-on-path-the-host-file-and-gcloud-b-808) |
| `cred:HARMONY_API_TOKEN` | present; when missing, the detail says why (no host file at `<path>`, no `secrets.api_token` entry in it, or the Secret Manager read failed) |
| `cred:board` | the board is readable with that token |
| `cred:github-app-key` | `HARMONY_APP_PRIVATE_KEY_PATH` names a readable file (or `HARMONY_APP_PRIVATE_KEY` is set) |
| `reach:gke-base-secret` / `reach:cloud-run-job` | `kubectl get secret <base secret>` / `gcloud run jobs describe` succeeds |
| `channel-branch` | restart only: the plugin checkout is on the config's `channel` branch, so the fast-forward pull means something |

## Which process is "this project's conductor"

`node <plugin checkout>/dist/bin/daemon.js ...`, matched on the **full command line**: the script must be this
checkout's `dist/bin/daemon.js`, and a process started with a different `--config` is excluded. It does not
match the ticket-disk sweep job, a `harmony` CLI invocation (including `harmony conductor stop`), the launcher
script (which `exec`s into node) or another checkout's conductor. A checkout path containing spaces is not
supported by the matcher.

## The environment file

`container/conductor-launch.sh` is the one place `~/.harmony/conductor.env` is loaded, for launchd, systemd and
`nohup` starts alike (`HARMONY_HOME` replaces `~/.harmony`). If only the old `~/.harmony/daemon.env` exists it is
loaded and one line is printed: `conductor-launch: reading ~/.harmony/daemon.env — rename it to
~/.harmony/conductor.env`. `container/gke/switch-daemon-profile.sh` follows the same preference. The conductor's
output goes to `~/.harmony/conductor.out.log` for every start these commands make.

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

Conductor started: host macmini, pid 9001, supervisor launchd-agent, plugin 0.15.80, log /Users/op/.harmony/conductor.out.log.
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

## Operator machines: `harmony` on PATH, the host file and gcloud (B-808)

### How the plugin puts `harmony` on PATH

Installing the plugin is enough; no repo checkout is needed. On **every session start** the plugin's
SessionStart hook `hooks/link-cli.sh` (registered after the build hook in `hooks/hooks.json`; POSIX `sh`, no
node, no network) keeps two things in place:

| What | Where | Content |
|---|---|---|
| Pointer | `${HARMONY_HOME:-~/.harmony}/plugin-root` | one line: the absolute path of the plugin directory running this session. Rewritten (atomically) whenever it differs, so a plugin update repoints it |
| Wrapper | `${HARMONY_BIN_DIR:-~/.local/bin}/harmony` | a tiny `sh` script that reads the pointer at run time and runs `node <plugin>/dist/bin/harmony.js "$@"`. Its **second line** is the marker `# harmony-plugin-shim v1`. It is written only if missing or carrying an older marker version, so it never changes on a plugin update |

Rules the hook keeps:

- **No clobbering.** A file (or symlink) already at the wrapper path without the marker is left untouched and
  the hook prints one line saying so. Move it aside to let the plugin manage `harmony`.
- **No profile edits.** If the bin dir is not on `PATH` the hook prints one line with the exact
  `export PATH="$HOME/.local/bin:$PATH"` to add. It never writes a shell profile or rc file.
- **Never fails the session.** Every error path exits 0 and prints at most one short line to stderr.
- **Last session wins.** A `claude --plugin-dir <checkout>` session (the staging channel) repoints the pointer
  at that checkout; the next ordinary session repoints it back. The wrapper follows whichever session started
  last.
- The wrapper reports a missing pointer, a missing `dist/bin/harmony.js` or a missing `node` as one line and
  exits 127. `dist/` is built by the build hook on first launch of a source checkout (installed plugins ship it).

**Manual fallback** (no hook, e.g. a machine that never runs Claude Code): create the same two things by hand.
Replace `<plugin dir>` with the plugin directory containing `dist/bin/harmony.js`.

```sh
mkdir -p ~/.local/bin ~/.harmony
printf '%s\n' "<plugin dir>" > ~/.harmony/plugin-root
cat > ~/.local/bin/harmony <<'WRAP'
#!/bin/sh
# harmony-plugin-shim v1
p="${HARMONY_HOME:-$HOME/.harmony}/plugin-root"
[ -r "$p" ] || { echo "harmony: no plugin pointer at $p" >&2; exit 127; }
IFS= read -r root < "$p"
t="$root/dist/bin/harmony.js"
[ -f "$t" ] || { echo "harmony: $t not found" >&2; exit 127; }
command -v node >/dev/null 2>&1 || { echo "harmony: node is not on PATH" >&2; exit 127; }
exec node "$t" "$@"
WRAP
chmod 755 ~/.local/bin/harmony
```

### Minimal operator-laptop host file

A laptop that only **operates** a remote conductor (`harmony conductor status`, `start --remote`, `stop --remote`,
`restart`) has no `conductor.env` and runs no conductor. It needs the registry, which needs `HARMONY_API_TOKEN`.
The token is not stored on the laptop; the host file names the Secret Manager secret that holds it, and the CLI
reads it in memory through `gcloud`. **There is no `harmony conductor config init` command** (`config` has only
`sync`, `migrate` and `doctor`): create `~/.harmony/conductor-host.json` by hand. Secret **names** only, never values:

```json
{
  "version": 1,
  "gcp": { "project": "<gcp-project-id>" },
  "gcloud": { "account": "<you@example.com>" },
  "secrets": { "api_token": "<secret-name>" }
}
```

- `secrets.api_token`: the Secret Manager secret holding the API token (becomes `HARMONY_API_TOKEN`).
- `gcp.project`: the project the secret lives in (the resolver also accepts `HARMONY_GCP_PROJECT`,
  `CLOUDSDK_CORE_PROJECT` or `GOOGLE_CLOUD_PROJECT` when the file does not set it).
- `gcloud.account`: the gcloud account to read it with (passed as `--account`), instead of gcloud's active one.

An exported `HARMONY_API_TOKEN` wins and costs no `gcloud` call. Without the file, or with a file that lacks
`secrets.api_token`, the commands fail with `HARMONY_API_TOKEN is not set and ...` naming which of the two it
is and the path it looked at; a failed Secret Manager read is reported with the secret name. Check the file
with `harmony conductor config doctor`. The other keys are in [`conductor-config.md`](conductor-config.md).

### gcloud and `gke-gcloud-auth-plugin`

An operator machine needs `gcloud` (logged in as the account above), `kubectl`, and, for the gke profile,
`gke-gcloud-auth-plugin` **on PATH**. `gcloud components install gke-gcloud-auth-plugin` can report "up to date"
while the plugin is still not on PATH, because the SDK adds its `bin/` to PATH only through the SDK's shell
include. The pre-flight (`tool:gke-gcloud-auth-plugin`) therefore finds the SDK root with
`gcloud info --format="value(installation.sdk_root)"` and, when the plugin is installed under it, tells you to
`source <sdk_root>/path.zsh.inc` (zsh) or `path.bash.inc` (bash); put that line in your shell profile. It prints
the line and never runs it.

### `harmony conductor status` on a laptop

With no conductor process on the machine, `status` prints `No conductor is running here.` and then the
registry's view (see [`status`](#harmony-conductor-status---json)), so it works from a laptop that has the host
file above (or `HARMONY_API_TOKEN` exported).

## Logs

`harmony conductor start` and `restart` send the conductor's raw stdout to `~/.harmony/conductor.out.log`. That is a
different file from the structured JSON-lines log `~/.harmony/logs/conductor.log` that `harmony conductor logs`
reads (B-1174; see [`conductor-config.md`](conductor-config.md#conductor-logs-b-1174)).


## The remote conductor (B-1173)

The operator's step-by-step is [`remote-conductor-runbook.md`](remote-conductor-runbook.md).

The remote conductor is the same daemon in one pod of the Deployment `harmony-conductor` (namespace
`harmony-conductor`, rolling update `maxSurge: 1`, `maxUnavailable: 0`), run with `HARMONY_CONDUCTOR_REMOTE=1`:

- **Identity:** the registry row says `location: remote`; logs are JSON lines on stdout (Cloud Logging).
- **Secrets:** `HARMONY_API_TOKEN` and the GitHub App key are read from Secret Manager at boot, by the names in
  the host file's `secrets` block (see [`conductor-config.md`](conductor-config.md#the-secrets-block-and-the-remote-conductor-b-1173)).
- **Readiness:** the file `HARMONY_READY_FILE` (default `/tmp/harmony-ready`) is written once pre-flight passed and
  the pod is either conducting or standing by; the pod's readinessProbe checks it. It is removed on shutdown.
- **Standby:** a rolling update surges a second pod while the first still holds the registry lease. A refused
  acquire does **not** exit in remote mode: the new pod logs once, launches nothing, keeps the process alive and
  retries (every 10s at most) until the old pod releases, then boots normally. Local conductors still exit on a
  refusal.
- **Restart / update request:** the claiming pod's restarter does not `git pull` or signal anything. It patches
  the Deployment through the pod's service account: *update* resolves the channel tag's newest plugin version tag
  in Artifact Registry (`HARMONY_CONDUCTOR_IMAGE`, channel from `HARMONY_PLUGIN_POSTURE`) and runs
  `kubectl set image` to the **pinned** `<image>:<version>` (never a moving tag); *restart* runs
  `kubectl rollout restart`. Then `kubectl rollout status --timeout=300s`. On success it does nothing more: the old
  pod is stopped by Kubernetes and releases cleanly, and the **new** pod completes the carried-over request as done
  with the plugin version before and after in the reason. On a missed deadline it runs `kubectl rollout undo` and
  completes the request **failed** with the reason (shown by `harmony conductor status`); the old conductor then
  resumes launching.
