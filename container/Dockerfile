# B-694: the Harmony build environment, layered for agent portability.
#
#   base  — agent-neutral: git + node toolchain + gh + the ONE baked file
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
# scripts/setup-channel-env.sh), jq (provision.sh parses get_project output).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates bash python3 jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Non-root worker; /workspace holds the runtime clones.
RUN useradd -m -s /bin/bash worker \
    && mkdir -p /workspace \
    && chown worker:worker /workspace

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
