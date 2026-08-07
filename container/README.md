# Harmony build environment (B-694)

A containerized, parametrized environment from which a REAL Harmony build-gate
run can execute — branch, edit, test, build `dist`, commit, push, open a PR —
on any machine with Docker: a daemon worker, a new laptop, or a trusted
collaborator.

## Quick start (the one documented command)

```bash
# 1. Configure once: copy env.example somewhere PRIVATE and fill it in.
cp container/env.example ~/.harmony-container.env && $EDITOR ~/.harmony-container.env

# 2. Build + run (from the repo root):
docker build -f container/Dockerfile --target agent -t harmony-build-env container \
  && docker run --rm -it --env-file ~/.harmony-container.env harmony-build-env
```

That clones `web/` + `plugin/` at the configured refs, provisions the run
directory via the same settings-triple mechanism as the B-488 staging channel,
confirms the environment pairing (`get_project` → `environment.target` must
match `HARMONY_TARGET`, aborting on mismatch), and drops you into the dogfood
shell. From there:

```bash
claude --plugin-dir /workspace/workspace/plugin      # an agent session in the container
harmony tasks list                          # or drive the CLI directly
```

Headless (what the Conductor Daemon's workers will run):

```bash
docker run --rm --env-file ~/.harmony-container.env harmony-build-env \
  headless "your prompt here"
```

Headless auth is **`CLAUDE_CODE_OAUTH_TOKEN`** (mint once via `claude
setup-token` — a ~1-year subscription token), keeping workers on Max
subscription economics. `ANTHROPIC_API_KEY` is a labelled fallback only: it
**overrides subscription auth and bills per-token**. provision.sh unsets
empty values of either so a blank env-file line can't shadow the real token,
and refuses headless mode with neither set.

## Interactive login

`CLAUDE_CODE_OAUTH_TOKEN` (above) only authenticates headless `claude -p` runs. The
**interactive TUI** (`claude --plugin-dir /workspace/workspace/plugin`) needs its own stored OAuth
session in `~/.claude` — a fresh `--rm` container has none, so it sends you to a browser
login with no explanation. Two paths:

- **One-time, this container only:** just run `claude --plugin-dir /workspace/workspace/plugin` and
  follow the browser prompt. The session lives only as long as this container — a fresh
  `--rm` run logs you in again.
- **Persistent across runs:** mount a named volume over `~/.claude` so the OAuth session
  survives container restarts:
  ```bash
  docker run --rm -it --env-file ~/.harmony-container.env \
    -v harmony-claude-auth:/home/worker/.claude harmony-build-env
  ```
  Log in once; subsequent runs with the same volume skip the browser step.

Daemon/headless workers are unaffected — they authenticate via `CLAUDE_CODE_OAUTH_TOKEN`,
not this interactive session.

## Layering (agent portability — CI-enforced)

| Target | Contents | Swap cost |
|---|---|---|
| `base` | git, node 22, gh, python3/jq, the bootstrap entrypoint — agent-neutral | never changes |
| `agent` | `FROM base` + Claude Code + `CLAUDE_HEADLESS_FLAGS` | replace to swap agents |

The `container-base` CI job rebuilds `base` on every PR and **fails if any
agent install is present in it** — the layering guardrail is continuously
checked, not a one-shot.

## Design properties

- **Nothing baked:** no Supabase ref, token, or repo snapshot lives in the
  image. Switching targets or rotating secrets is a config change, never a
  rebuild.
- **Provisioning-from-clone:** the image bakes ONLY `entrypoint.sh`
  (validate → clone → hand off). Everything substantive runs from
  `container/provision.sh` at the CLONED plugin ref, so provisioning can never
  drift from the plugin it provisions.
- **Read plane ≠ deploy plane:** `HARMONY_TARGET` picks which board/DB the
  MCP + CLI talk to (default `prod` — where tickets live). Deploys happen in
  CI from GitHub secrets after a merge; the container never deploys.
- **Known v1 tradeoff:** every start pays a fresh clone of web + plugin.
  Accepted (see the B-694 design entry); mount a volume over `/workspace` to
  reuse clones across runs if it bothers you.

Heavy builds (web E2E, local Supabase, Docker-in-Docker) are NOT covered by
this image — that substrate is B-708, extending these same targets when the
first heavy-build ticket needs it.

## Conductor daemon (B-696)

The conductor daemon (`dist/bin/daemon.js`) watches every active conduction's
ticket and fires a fresh one-shot `harmony-conduct` worker (a container from
this image) whenever the ball returns to the agent. Create conductions with
`harmony conduct <ticket>`; the daemon does the rest — heartbeats, CAS
takeover of stale leases (reap-then-fire), exit classification, and
park-and-flag for anything off the happy path (no auto-retry).

### Install (launchd, macOS)

```bash
# 1. Build once so dist/bin/daemon.js exists (or use the committed dist/).
npm run build

# 2. Copy the launch profile and adjust if needed (worker image, env-file path).
cp container/daemon-profile.example.json ~/harmony-daemon-profile.json

# 3. Copy the plist, fill in the REPLACE-ME placeholders (node path via
#    `which node`, absolute dist path, token, profile path, log paths).
cp container/launchd/com.ycomplex.harmony-daemon.plist ~/Library/LaunchAgents/

# 4. Load it (RunAtLoad starts it immediately; KeepAlive restarts it on death).
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.ycomplex.harmony-daemon.plist
```

Status / logs / stop:

```bash
launchctl print gui/$UID/com.ycomplex.harmony-daemon   # status
tail -f ~/Library/Logs/harmony-daemon.log              # logs
launchctl bootout gui/$UID/com.ycomplex.harmony-daemon # stop + unload
```

### Run it directly (no launchd)

launchd is one option, not the mechanism. All that matters is that **the daemon
process's environment carries the knobs** — the launch profile's `launch`
template runs as a shell command spawned by the daemon and inherits its env. So
running it straight from a terminal works identically:

```bash
HARMONY_DAEMON_PROFILE=~/.harmony-daemon-profile.json \
HARMONY_API_TOKEN=harmony_… \
HARMONY_APP_ID=… \
HARMONY_APP_INSTALLATION_ID=… \
HARMONY_APP_PRIVATE_KEY_PATH=/absolute/path/to/harmony-daemon.private-key.pem \
HARMONY_PLUGIN_DIR=/absolute/path/to/harmony-plugin \
node plugin/dist/bin/daemon.js
```

Two gotchas specific to this form:

- **Use an absolute path for the key, or leave the tilde unquoted.** The mint
  script does a plain `readFileSync` and Node does not expand `~`. Your shell
  expands `VAR=~/key.pem` in a command prefix, but `VAR="~/key.pem"` it does not
  — that fails with ENOENT.
- **Prefer `HARMONY_APP_PRIVATE_KEY_PATH` over the inline
  `HARMONY_APP_PRIVATE_KEY`.** A command prefix puts values in the host process
  table, so pasting PEM contents there exposes the private key to anything
  running as you. The path form exposes only a filename.

Whichever form you use, the live profile is whatever `HARMONY_DAEMON_PROFILE`
points at — a **copy** of `daemon-profile.example.json`. Editing the example in
this repo does **not** update your live profile; re-copy it after a template
change.

### The credential envelopes

- **Worker creds** (`CLAUDE_CODE_OAUTH_TOKEN`, Supabase overrides, and the
  minted `GIT_TOKEN`) live **only** in the `--env-file` referenced by the launch
  profile's command template (`env.example` documents the set). They never enter
  the daemon process, so a daemon-side leak cannot spend Claude credits.
- **Daemon env** carries `HARMONY_API_TOKEN` — ticket reads and conduction
  writes — **plus the `harmony-daemon` App mint knobs** (`HARMONY_APP_ID`,
  `HARMONY_APP_INSTALLATION_ID`, `HARMONY_APP_PRIVATE_KEY_PATH`) since B-732,
  because the launcher mints the worker's git token before `docker run`.

**What a daemon-side leak actually costs (corrected at B-732).** This section
previously claimed the daemon env carried *only* `HARMONY_API_TOKEN` and that a
daemon-side leak "can never mint commits". That is no longer true: whoever holds
the App private key can mint a ~1h installation token. The honest property, and
the one B-695 designed for, is narrower but still strong:

> A leaked daemon credential is a **PR-spam risk, not a merge risk.**

The App is non-admin (`contents: write` + `pull_requests: write` + `metadata:
read`) and holds **zero bypass allowance** on all three repos (`apps: []`). So a
stolen key can push branches and open PRs, but **cannot reach `main`** — the
required review is one no bot-credentialed actor can supply, because GitHub
forbids a PR author approving its own PR. Claude credits remain worker-only.

### Worker PRs are authored by the bot (B-732)

The B-695 merge floor only engages on PRs the founder **cannot** merge without a
review — and GitHub decides that by PR **author**. While workers authenticated
with a founder PAT, every daemon PR was founder-authored and took the bypass
lane, so the floor protected nothing.

So the launch profile mints a credential per run:

1. `scripts/mint-installation-token.mjs` signs an RS256 JWT from the
   `harmony-daemon` App key and exchanges it for a **~1h installation token**.
2. It writes a **per-run env-file at mode 0600** — the static env-file above
   plus that token as `GIT_TOKEN`, with any pre-existing `GIT_TOKEN` **stripped**
   rather than merely overridden. The token is never passed as `docker run -e`
   and never crosses a command line, so it cannot be read from the host process
   table.
3. `reap` deletes the per-run file, so a minted credential never outlives its
   worker.

Set these on the **launcher host** (they never enter the container — only the
minted `GIT_TOKEN` does):

| Knob | Meaning |
|---|---|
| `HARMONY_APP_ID` | The `harmony-daemon` App id. |
| `HARMONY_APP_INSTALLATION_ID` | The installation to mint a token for. |
| `HARMONY_APP_PRIVATE_KEY_PATH` | Path to the App private key PEM (preferred over the inline `HARMONY_APP_PRIVATE_KEY`, which needs newline escaping). |
| `HARMONY_PLUGIN_DIR` | Checkout the launch template runs the mint script from. |

**The App must be installed on every repo the container clones** — `harmony-web`,
`harmony-plugin` **and** `harmony-workspace`. Its installation is repo-selected,
so a repo left out fails at the clone step, not at push time.

**Consequence at the release gate:** a bot-authored PR cannot be merged until you
approve it on GitHub. `finish-work` asserts bot authorship inside a worker run and
**hard-errors rather than merging** if the PR came out founder-authored (that means
the identity swap failed, and merging would silently ride the bypass again). When
the PR is un-approved it flags the ticket `release-approval-pending` with the PR
attached, so it lands in your queue and your resolution wakes the daemon to retry.

**Token expiry is known behaviour, not a solved problem.** The token lasts ~1h. A
build that outruns it fails at push, which is a dirty exit, which fires B-713's
bounded retry with a fresh container and a fresh token; whether in-progress work
survives depends on B-722's patch-preservation ladder. Revisit if a real build is
ever observed exceeding the lifetime.

### Config, not constants (B-711)

Everything operational is an env knob or a profile file — never a code edit:

| Knob | Default | Meaning |
|---|---|---|
| `HARMONY_DAEMON_PROFILE` | *(required unless `--profile` resolves — see below)* | Path to the launch-profile JSON: `{ launch, reap }` command templates (plus two OPTIONAL fields, B-717 — see below) with `{conduction_id}` / `{ticket}` placeholders. No baked-in worker command — swapping agent brands is a profile edit. |
| `HARMONY_DAEMON_POLL_MS` | `25000` | Pass cadence (one watch/heartbeat pass per interval — a pass never blocks on a worker, B-717). |
| `HARMONY_DAEMON_HEARTBEAT_MS` | `30000` | Lease heartbeat cadence (poll ≤ heartbeat). |
| `HARMONY_DAEMON_STALE_MS` | `300000` | Silence threshold after which another daemon may CAS-take the lease. |
| `HARMONY_DAEMON_RETRY_CAP` | `2` | Bounded retries for a dirty worker exit before the conduction parks. `0` disables retry (immediate park, pre-B-713 behavior). |
| `HARMONY_DAEMON_RETRY_BACKOFF_MS` | `15000` | Base backoff between a dirty exit and its retried re-fire — B-717 made this EXPONENTIAL (`backoff * 2**(attempt-1)`), so this knob is the FIRST retry's delay, not a flat one. |
| `HARMONY_DAEMON_MAX_CONCURRENT_WORKERS` | *(profile's own, else `3`)* | B-717: the fire-and-track concurrency cap — how many workers this daemon runs at once. Overrides the launch profile's own `maxConcurrentWorkers` (see below) when set; falls back to 3 (sized for local-docker's host resource ceiling) when neither is set. |
| `HARMONY_DAEMON_READY_AGE_MS` | `600000` (10 min) | B-717: a ready-but-unfired conduction waiting longer than this is promoted one priority tier for firing order only (aging escalation — prevents starvation under a sustained high-priority stream). |
| `HARMONY_DAEMON_LOG` | *(unset)* | Optional extra log file (stdout is primary; launchd redirects it). |

**B-800: select a profile BY NAME from a deployment config instead** — `node dist/bin/daemon.js
--config <deployment.json path> --profile <name>` (mirrors the `harmony config get` CLI's own
`--config`; `HARMONY_DEPLOYMENT_CONFIG` works too). This wins over `HARMONY_DAEMON_PROFILE`
whenever it FULLY resolves (the config file is present AND `--profile` names a profile that exists
in its `profiles` section); short of that, the daemon falls back to `HARMONY_DAEMON_PROFILE`
unchanged, so an existing single-profile deployment needs zero config changes. One machine can run
multiple daemon deployments this way, each with its own deployment-config file bound to a different
board — see **`container/migrate-to-deployment-config.md`** for the human, once, migration
procedure (two worked examples: the default single-deployment case, and a second differently-named
deployment at a non-default path).

**B-717 optional profile fields** (alongside `launch`/`reap` in the profile JSON):

- **`probe`** — a command template that exits 0 when a worker for `{conduction_id}` is still
  running, non-zero when it is not. Used ONLY for restart reconciliation: on a newly-won takeover
  of a lease whose worker MIGHT still genuinely be running (this daemon's own restart, or a dead
  peer), the daemon probes before ever reaping — found ⇒ re-attaches (never re-fires a second
  worker alongside a live one); not found ⇒ falls back to the pre-B-717 REAP-THEN-FIRE. A profile
  that omits `probe` simply skips reconciliation entirely (safe, if slightly blunter — every
  takeover reaps defensively, as it always did).
- **`maxConcurrentWorkers`** — this profile's own concurrency default (see the env var above,
  which always wins when set). Sized per launch mechanism: local-docker's example profile sets 3
  (the host resource ceiling); the cloud example profile sets a more conservative 2 pending live
  rate-limit data — override on the daemon host to match your subscription/quota.

Worker containers are named `harmony-worker-<conduction_id>` (the example
profile's templates), so `docker ps` maps running workers to conductions and
the reap template can remove a dead holder's worker by name — this naming is
ALREADY per-conduction-unique (confirmed B-717 AC6: two conductions firing
concurrently on the local-docker profile never share a container name, bind
mount, or env-file — each is namespaced by `{conduction_id}`).

### Worker transcripts survive the container (B-724)

Worker containers run `--rm`, but the raw Claude session transcript — every
tool call and tool result, verbatim, including exact error/permission
messages — is the thing you need when asking "why did the worker do that?".
The launch template therefore pre-creates a per-conduction host directory and
bind-mounts it over the worker's session-log locations before `docker run`:

```
$HOME/.harmony-conductions/<ticket-uuid>/<conduction-id>/
├── projects/<cwd-hash>/<session-uuid>.jsonl   # one transcript per one-shot leg
└── logs/                                      # Claude Code's own logs
```

To debug a worker, open the newest `.jsonl` under the conduction's
`projects/` dir. Each one-shot leg is a fresh Claude session writing its own
`<session-uuid>.jsonl`, so legs never overwrite each other; file mtime orders
them. The daemon never reads these files — capture is for a human,
never for control flow (the same boundary as worker-stdout capture).

Three constraints — the first two probe-proven at the B-724 design gate, the
third caught by a live daemon leg at verify:

- **The base dir must sit under a Docker-file-shared path** (`$HOME`
  qualifies). Outside the sharing map the "mount" lands inside the VM and the
  host dir never appears.
- **The template must `mkdir -p` the host dirs BEFORE `docker run`.** Docker
  auto-creates missing bind sources root-owned, and the uid-1001 worker then
  gets `Permission denied` writing its own transcript.
- **The image must pre-create the container-side mount targets worker-owned**
  (the Dockerfile agent target does). Docker creates mount-point *parents*
  root-owned inside the container, so mounting under `~/.claude` otherwise
  breaks any non-mounted sibling writer — the B-719 declared-agent install
  (`mkdir ~/.claude/agents`) died exactly this way on a live leg.

`src/daemon/profile-contract.test.ts` pins both mounts, the per-conduction
namespacing, the mkdir-p preamble, and the Dockerfile's worker-owned
pre-creation of every mount target.

**Deploy note:** the example profile is not read at runtime — apply the same
template change to the live profile named by `HARMONY_DAEMON_PROFILE`, then
restart the daemon (`launchctl bootout` + `bootstrap`, per Install above).
The mount-parent fix lives in the image: **rebuild it** (`docker build -f
container/Dockerfile --target agent -t harmony-build-env container`) so the
next worker leg runs with worker-owned `~/.claude`.

**Security:** transcripts can carry tool-call payloads including tokens. The
hardening — access-scoping the base dir, a retention/cleanup sweep, token
redaction where feasible — is **B-725** (Conductor Daemon v1.5); until it
lands, transcripts sit host-side with default file permissions (interim
posture accepted at the B-724 clarify). **B-718** (session resume) reuses
this same per-conduction `projects/` dir by re-mounting it into the next leg.

### Cloud launch profile (B-754)

The local-Docker profile above (`daemon-profile.example.json`) is the v1
dogfood default and stays exactly as-is. **`daemon-profile.cloud.example.json`**
is a SECOND, additive launch profile: it fires each worker as a **Cloud Run
job execution** instead of `docker run`, so builds run on a properly-sized
cloud worker (8 GB / 4 vCPU, per B-694's `harmony-build-env` image) instead of
the founder's laptop. Selection is via the SAME `HARMONY_DAEMON_PROFILE` env
var — there is no new selection mechanism; point it at a copy of the cloud
profile instead of the docker one to switch. The daemon's scheduler/classify
code (`src/daemon/scheduler.ts`, `src/daemon/classify.ts`) is completely
untouched: it still just runs the profile's `launch` command to completion and
reads its exit code. All Cloud Run CLI ambiguity is absorbed inside two new
wrapper scripts the profile points at:

- `container/cloud-worker-launch.sh` — mints the per-run bot-identity token
  exactly as the docker profile does (B-732, unchanged), fires
  `gcloud run jobs execute --wait` labelled `conduction-id=<id>`, and then
  — REGARDLESS of `--wait`'s own exit code, which is not precisely documented
  — makes an authoritative second call
  (`gcloud run jobs executions describe`) and derives its OWN exit code only
  from `status.succeededCount` / `status.failedCount` (0 for succeeded, 1 for
  everything else, including "still reconciling" — never a guess at success).
- `container/cloud-worker-reap.sh` — resolves the still-running execution by
  the same `conduction-id` label (Cloud Run assigns the execution name itself,
  so reap can't blind-name-target like `docker rm -f harmony-worker-{id}`),
  cancels it async, tolerates "not found" as a no-op, and deletes the per-run
  minted env-file.

**Already done (founder, one-time GCP project setup):**

| Item | Value |
|---|---|
| Project | `harmony-conductor` |
| Region | `us-central1` |
| Daemon-host SA | `harmony-daemon@harmony-conductor.iam.gserviceaccount.com` (`roles/run.developer`, `actAs` on the worker SA) |
| Worker runtime SA | `harmony-worker@harmony-conductor.iam.gserviceaccount.com` (`secretAccessor` on both secrets below) |
| Secret Manager | `HARMONY_API_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Artifact Registry | `harmony-workers` docker repo, `us-central1` |
| Daemon-host key file | `~/.harmony/gcp-daemon-sa.json` |

The two wrapper scripts pin `CLOUDSDK_CORE_ACCOUNT` /
`CLOUDSDK_CORE_PROJECT` to these values as **example env-var defaults** (B-711
"config not constants" — override on the daemon host, they are not baked-in
constants): `HARMONY_CLOUD_RUN_REGION`, `HARMONY_CLOUD_RUN_JOB`,
`CLOUDSDK_CORE_PROJECT`, `CLOUDSDK_CORE_ACCOUNT`.

**Still outstanding before flipping the daemon over to this profile:**

1. Create/verify the actual Cloud Run **job resource** — pointing at the
   `harmony-build-env` image in the `harmony-workers` Artifact Registry repo,
   sized 8 GB / 4 vCPU, with `--set-secrets` binding
   `HARMONY_API_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` from Secret Manager onto
   the job definition. (Unlike the per-execution `GIT_TOKEN`, these two are
   NOT passed per-run any more — they're bound once, to the job, not the
   execution.)

   **Required flags, from live observation (2026-08-03) — the defaults below would silently kill or
   starve a real build leg:**
   - `--service-account=harmony-worker@harmony-conductor.iam.gserviceaccount.com` — REQUIRED; job
     creation fails `actAs` on the default compute SA under the scoped `harmony-daemon` SA without it.
   - `--max-retries=0` — Cloud Run defaults to 3 internal task retries, which would stack under the
     daemon's own B-713 retry ladder and could run one failing leg up to 4x.
   - `--task-timeout=5400s` — observed default (600s) would kill a real build leg mid-run.
   - `--memory=8Gi --cpu=4` — observed defaults (512Mi / 1 vCPU) would starve a real build leg;
     matches B-694's proven sizing.
2. Copy `daemon-profile.cloud.example.json` to a live profile file and point
   `HARMONY_DAEMON_PROFILE` at it (same mechanism as the docker profile —
   editing the example here never updates a live profile).

**Cross-build note (do this or executions 404/CrashLoop):** the daemon host is
very likely Apple Silicon (arm64 — launchd/colima), but Cloud Run job
executions are **linux/amd64-only**. Publish the worker image with
`docker buildx build --platform linux/amd64 ... --push` to the
`harmony-workers` Artifact Registry repo — never a plain host-native
`docker build`, which would produce an arm64 image Cloud Run can't run.

**Credentials:** the daemon host needs its own least-privilege GCP identity to
call `execute` / `executions cancel` / `executions list` — `roles/run.developer`
scoped to this one job (already granted to `harmony-daemon@...`, above).

**Known gap, carried forward, not this ticket's job to fix:** transcript
persistence (B-724, directly above) is a local bind-mount — there is no
equivalent host filesystem to mount into a remote Cloud Run job execution. A
GCS-based replacement is explicitly out of scope for this leg; until something
lands, cloud-launched workers have **no transcript capture**.

**Confirmed via live observation (2026-08-03):**

- Exit-code parsing is correct: `status.succeededCount` / `status.failedCount` / `status.completionTime`
  matches the real `executions describe` output. Observed shapes: succeeded =
  `conditions[type=Completed].status=="True"` + `succeededCount:1`; failed = `status=="False"`,
  `reason:"NonZeroExitCode"`, `failedCount:1`. The wrapper still parses only the count fields for
  control flow, never the conditions array.
- `execute --wait` collapses the launched container's own exit code down to a simple pass/fail signal
  (observed: container exit code 7 -> `gcloud` exit code 1).
- A pending `execute --wait` unblocks promptly on a concurrent `executions cancel`: it unblocked within
  ~7s in observation (wait returned 12:10:54Z; cancel's own confirmation printed 12:11:01Z), exit code
  1, streamed "Cancelled by user." The primary `--wait` strategy is sufficient; the bounded-poll
  contingency once considered is confirmed not needed.
- The inline `--update-env-vars` flag (no `-file` suffix) is also accepted by `execute` and lands on
  that execution's spec — but is deliberately NOT adopted for GIT_TOKEN: this ticket's own test suite
  requires the secret never appear on the command line, so GIT_TOKEN stays file-based. Whether the
  inline form can be combined with the file-based form for the two non-secret scalars (CONDUCTION_ID,
  TICKET) is unresolved — needs a live check that both flags can be passed together in one `execute`
  call.

**Still deferred / not live-verified:**

- The exact `gcloud run jobs execute` flag/format for the FILE-based env-vars input
  (`--update-env-vars-file` here) is still a best guess, isolated in `write_exec_env_file()` in
  `cloud-worker-launch.sh` so it's a one-line fix if the real flag name differs — verify against
  `gcloud run jobs execute --help` on the real project.
- A reaped/cancelled execution is indistinguishable from a failed one by exit code, and this must
  remain so — the daemon's own in-process `timedOut` flag (`src/daemon/scheduler.ts`) owns
  worker-timeout classification, per `classify.ts`'s never-key-on-the-code rule.

**B-717 (serial-execution/concurrency, named constraint):**
`--update-env-vars` mutates the Cloud Run **job definition** itself before
`execute` reads it — there's no per-execution-only variant of that flag. Two
concurrent `execute` calls would race each other's env values through that
shared mutation. This is safe only because the daemon fires strictly one
build at a time today; see the comment at the call site in
`cloud-worker-launch.sh` for the full constraint.

Extended coverage lives in `src/daemon/profile-contract.test.ts` (new
describe blocks, additive only — none of the existing docker-profile tests
were touched).
