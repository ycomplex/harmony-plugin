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
