# B-694: the Harmony build environment, layered for agent portability.
#
#   base  — agent-neutral: git + node toolchain (B-929: plus the fnm/corepack
#           toolchain MANAGER, so a cloned repo can pin its own Node/package
#           manager) + gh + the ONE baked file
#           (entrypoint.sh). Repos are cloned at container start and
#           provisioning runs FROM that clone, so nothing baked here can
#           drift from the plugin ref it provisions. CI builds this target
#           and asserts no agent is present in it.
#   agent — FROM base: the Claude Code install + the headless permission
#           envelope. This is the ONLY layer an agent swap replaces.
#
# Config and secrets are runtime-injected (docker run --env-file; see
# env.example). No Supabase ref, token, or repo snapshot is baked — switching
# targets or rotating secrets never rebuilds this image.

FROM node:22-bookworm-slim AS base

# Toolchain: git (clone/branch/push), gh (open PRs), curl + ca-certificates
# (installers, Supabase HTTPS), python3 (the settings-triple merge writer in
# scripts/setup-channel-env.sh), jq (provision.sh parses get_project output),
# unzip (B-929: fnm ships its release as a .zip, see the fnm layer below).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates bash python3 jq unzip \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# B-929 lever 1: the toolchain MANAGER, agent-neutral and therefore base-layer.
# A build leg for a project that pins a different Node (or a different package
# manager) than Harmony's own used to die on this image's single baked Node 22.
# fnm is the ONE new base binary — corepack already ships with the node:22 base
# image (0.34.6, verified live) and is used as-is, never reinstalled.
#
# Installed SYSTEM-WIDE (/usr/local/bin) rather than through fnm's install
# script's per-user default, so the non-root `worker` user below resolves it on
# the stock PATH with no shell-rc dance. FNM_DIR (where fnm PUTS the Node
# versions it downloads) is separately pointed at a worker-owned dir — the
# binary is root-owned and read-only, the version store is the worker's.
#
# The version store stays EMPTY at build time: nothing is downloaded until a
# cloned repo actually declares a pin (container/activate-toolchain.sh), so an
# image build never bakes in a second Node.
ARG FNM_RELEASE=latest
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) fnm_asset=fnm-linux.zip ;; \
      arm64) fnm_asset=fnm-arm64.zip ;; \
      *) echo "B-929: no fnm release asset for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    if [ "$FNM_RELEASE" = latest ]; then \
      fnm_url="https://github.com/Schniz/fnm/releases/latest/download/$fnm_asset"; \
    else \
      fnm_url="https://github.com/Schniz/fnm/releases/download/$FNM_RELEASE/$fnm_asset"; \
    fi; \
    curl -fsSL -o /tmp/fnm.zip "$fnm_url"; \
    unzip -q /tmp/fnm.zip -d /tmp/fnm; \
    install -m 0755 /tmp/fnm/fnm /usr/local/bin/fnm; \
    rm -rf /tmp/fnm /tmp/fnm.zip; \
    fnm --version

# Non-root worker; /workspace holds the runtime clones.
RUN useradd -m -s /bin/bash worker \
    && mkdir -p /workspace \
    && chown worker:worker /workspace

# B-929: fnm's version store, worker-owned (the binary above is root-owned).
# Set as an ENV so every shell in the container — provision.sh, the leg's agent,
# a dogfood `docker run ... shell` — agrees on one store without sourcing
# anything.
ENV FNM_DIR=/home/worker/.fnm
RUN mkdir -p /home/worker/.fnm && chown -R worker:worker /home/worker/.fnm

# Plain COPY + chmod (not COPY --chmod) so the build works on non-BuildKit
# builders too.
COPY entrypoint.sh /usr/local/bin/harmony-entrypoint.sh
RUN chmod 755 /usr/local/bin/harmony-entrypoint.sh

USER worker
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/harmony-entrypoint.sh"]
CMD ["shell"]


FROM base AS agent

# The agent layer: Claude Code + the permission envelope. Nothing in this
# target may move up into base — the container-base CI job asserts base has
# no `claude`.
USER root
RUN npm install -g @anthropic-ai/claude-code \
    && claude --version

# B-724: pre-create the worker's Claude state dirs WORKER-OWNED. The launch
# profile bind-mounts projects/ and logs/ per conduction; Docker otherwise
# creates the mount-point parent ~/.claude AS ROOT at container create, and
# provision.sh's declared-agent install (mkdir ~/.claude/agents, B-719) then
# dies with Permission denied — a non-mounted sibling under a root-owned
# parent (live daemon leg, 2026-07-27). profile-contract.test.ts pins every
# mount target in the launch template to a pre-created dir here.
RUN mkdir -p /home/worker/.claude/projects /home/worker/.claude/logs /home/worker/.claude/agents \
    && chown -R worker:worker /home/worker/.claude
USER worker

# The headless permission envelope (B-694 AC4): the container IS the sandbox
# that makes a broad grant safe; provision.sh passes these flags to the
# non-interactive `claude -p` run. Override per-run via the env file.
ENV CLAUDE_HEADLESS_FLAGS="--dangerously-skip-permissions"

# B-719: neither the CLI flag above nor a settings.json defaultMode bake
# reaches Task-tool subagents in headless -p (minimal repros on the ticket —
# the settings bake was tried here and disproven). The build subagent's bypass
# ships as a DECLARED agent (container/agents/harmony-build.md) that
# provision.sh installs to ~/.claude/agents/ at startup; its frontmatter
# permissionMode is the one honored lever. The marker below is the mode
# discriminator start-work keys park-vs-fallback on (diagnostic-grade: a
# misprovisioned container still fails visibly without it — see the B-719
# design entry).
ENV HARMONY_BUILD_CONTAINER=1
