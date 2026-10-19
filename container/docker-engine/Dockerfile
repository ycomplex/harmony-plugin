# B-708: the container-runtime LAYER — a worker image that can start its own
# Docker engine, so a leg can run the project's own container stack
# (Docker-in-Docker).
#
# A SEPARATE Dockerfile on purpose, not a third target in container/Dockerfile:
# that file's LAST stage must stay `agent` (every documented publish command
# builds its default target), and this layer is opt-in per deployment. It sits on
# top of whatever worker image the deployment already runs — the shared base, the
# agent image, or a project's generated image (container/worker-image/):
#
#   docker build -f container/docker-engine/Dockerfile \
#     --build-arg BASE=harmony-build-env -t harmony-build-env-docker \
#     container/docker-engine
#
# The engine only STARTS in a container run `--privileged` (see
# container/provision.sh's B-708 block and container/README.md "Docker-host
# launch profile"). On any other launch profile this layer is inert: the start
# script fails, provision.sh warns, and the leg continues without a runtime.

# B-1162 additions (on top of the B-708 engine layer):
#   * Chromium's SYSTEM libraries are baked in (what `playwright install --with-deps
#     chromium` would apt-install), so a leg that runs the project's browser tests
#     only downloads the browser binary, never needs root or apt at run time. The
#     browser itself is deliberately NOT in the image.
#   * PLAYWRIGHT_BROWSERS_PATH defaults to /home/worker/.cache/ms-playwright, a
#     worker-owned directory. That path is what the pool Job should mount the
#     ticket disk subPath `playwright` at (with pod fsGroup 1001, the worker's
#     gid) so the downloaded browser survives across legs of a ticket (B-1161
#     implements the mount). With no mount it is an ordinary image directory and
#     each leg simply downloads the browser again.
#   * This image is published by the SAME Cloud Build run as the base
#     (container/cloudbuild.yaml build-docker .. push-docker-latest), after the
#     base has been pushed.

ARG BASE=harmony-build-env
# The harmony.claude_code_version and harmony.source_commit_time labels are
# inherited from the BASE through this FROM; this layer does not redefine them.
FROM ${BASE}

USER root

# Docker Engine from Docker's own apt repository (the distro's docker.io lags and
# carries no compose/buildx plugins). The base is Debian bookworm
# (node:22-bookworm-slim); the codename is read from the image rather than
# written here so a base bump does not silently install the wrong suite. curl
# and ca-certificates are already in the base (container/Dockerfile).
# sudo: the worker starts the engine through ONE sudoers rule (below).
# iptables: dockerd programs its bridge NAT with it and does not pull it in under
# --no-install-recommends.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
         > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
         docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin \
         sudo iptables \
    && rm -rf /var/lib/apt/lists/*

# The worker talks to the engine's socket without sudo once it is up.
RUN usermod -aG docker worker

# Plain COPY + chmod (not COPY --chmod) so the build works on non-BuildKit
# builders too — same convention as container/Dockerfile.
COPY start-dockerd.sh /usr/local/bin/harmony-start-dockerd
RUN chown root:root /usr/local/bin/harmony-start-dockerd \
    && chmod 0755 /usr/local/bin/harmony-start-dockerd

# The ONE thing the non-root worker may run as root: the start script, by its
# exact path, with no arguments it controls. Validated at build time so a
# malformed drop-in fails the image build, not a leg.
RUN echo 'worker ALL=(root) NOPASSWD: /usr/local/bin/harmony-start-dockerd' \
      > /etc/sudoers.d/harmony-dockerd \
    && chmod 0440 /etc/sudoers.d/harmony-dockerd \
    && visudo -cf /etc/sudoers.d/harmony-dockerd

# B-1162: Chromium system libraries, as root, via Playwright's own dependency
# list (node/npm come from the base). Apt lists and the npx cache are cleared in
# the SAME layer so neither the lists nor the playwright package stay behind.
RUN npx -y playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm/_npx

# B-1162: worker-owned browser cache (the pool Job's `playwright` subPath mount
# point). /home/worker/.cache itself is created worker-owned too.
RUN mkdir -p /home/worker/.cache/ms-playwright \
    && chown worker:worker /home/worker/.cache /home/worker/.cache/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/home/worker/.cache/ms-playwright

USER worker
