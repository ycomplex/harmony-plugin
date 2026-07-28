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
claude --plugin-dir /workspace/plugin      # an agent session in the container
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
**interactive TUI** (`claude --plugin-dir /workspace/plugin`) needs its own stored OAuth
session in `~/.claude` — a fresh `--rm` container has none, so it sends you to a browser
login with no explanation. Two paths:

- **One-time, this container only:** just run `claude --plugin-dir /workspace/plugin` and
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

### The two-envelope credential rule

- **Daemon env** (the plist's `EnvironmentVariables`) carries **only**
  `HARMONY_API_TOKEN` — ticket reads + conduction writes. Nothing else.
- **Worker creds** (git token, `CLAUDE_CODE_OAUTH_TOKEN`, Supabase overrides)
  live **only** in the `--env-file` referenced by the launch profile's
  command template (`env.example` documents the set). They never enter the
  daemon process, so a daemon-side leak can never mint commits or spend
  Claude credits.

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
| `HARMONY_DAEMON_PROFILE` | *(required)* | Path to the launch-profile JSON: `{ launch, reap }` command templates with `{conduction_id}` / `{ticket}` placeholders. No baked-in worker command — swapping agent brands is a profile edit. |
| `HARMONY_DAEMON_POLL_MS` | `25000` | Pass cadence (one watch/heartbeat pass per interval). |
| `HARMONY_DAEMON_HEARTBEAT_MS` | `30000` | Lease heartbeat cadence (poll ≤ heartbeat). |
| `HARMONY_DAEMON_STALE_MS` | `300000` | Silence threshold after which another daemon may CAS-take the lease. |
| `HARMONY_DAEMON_RETRY_CAP` | `2` | Bounded retries for a dirty worker exit before the conduction parks. `0` disables retry (immediate park, pre-B-713 behavior). |
| `HARMONY_DAEMON_RETRY_BACKOFF_MS` | `15000` | Backoff between a dirty exit and its retried re-fire. |
| `HARMONY_DAEMON_LOG` | *(unset)* | Optional extra log file (stdout is primary; launchd redirects it). |

Worker containers are named `harmony-worker-<conduction_id>` (the example
profile's templates), so `docker ps` maps running workers to conductions and
the reap template can remove a dead holder's worker by name.

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
