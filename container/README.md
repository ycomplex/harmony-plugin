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
