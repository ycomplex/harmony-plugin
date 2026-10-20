# B-1173: the REMOTE CONDUCTOR image — the daemon plus everything it shells out to, running as one Deployment pod
# (`harmony-conductor` in namespace `harmony-conductor`) on the project's GKE cluster.
#
# Built by container/conductor/cloudbuild.yaml from the `staging` or `prod` BRANCH of this repo, because only those
# carry the built dist/ (main is source only — see CLAUDE.md "Versioning"). Build context = the repo root:
#
#   docker build -f container/conductor/Dockerfile --build-arg PLUGIN_VERSION=<v> -t <image>:<tag> .
#
# What it holds, and why:
#   node 22      the daemon and the harmony CLI (dist/ is a self-contained esbuild bundle; no node_modules needed)
#   gcloud       Secret Manager reads at boot (src/config/conductor-secrets.ts), Cloud Run launches, Artifact
#                Registry tag listing for `update`; authenticates through Workload Identity (no key file)
#   kubectl      the gke launcher and `rollout` verbs; in a pod it uses the service account token, no kubeconfig
#   jq, bash     the launch scripts under container/
# No credential is baked: HARMONY_API_TOKEN and the GitHub App key arrive from Secret Manager at boot, and the
# image carries no Supabase ref. Rotating a secret never rebuilds this image.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq bash \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
         > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli kubectl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/harmony-plugin
# Only what runs: the built bundle, the manifest (version), the launch scripts and the skills the daemon reads.
COPY .claude-plugin ./.claude-plugin
COPY dist ./dist
COPY container ./container
COPY skills ./skills
COPY package.json ./package.json

# `harmony` on PATH, the way the sweep and the conductor lifecycle verbs call it.
RUN printf '#!/bin/sh\nexec node /opt/harmony-plugin/dist/bin/harmony.js "$@"\n' > /usr/local/bin/harmony \
    && chmod 0755 /usr/local/bin/harmony \
    && chmod 0755 /opt/harmony-plugin/container/conductor/entrypoint.sh \
    && mkdir -p /var/harmony && chown node:node /var/harmony

ARG PLUGIN_VERSION=unknown
ARG SOURCE_COMMIT=unknown
LABEL harmony.plugin_version="${PLUGIN_VERSION}" \
      harmony.source_commit="${SOURCE_COMMIT}" \
      org.opencontainers.image.title="harmony-conductor"

ENV HARMONY_PLUGIN_DIR=/opt/harmony-plugin \
    HARMONY_HOME=/var/harmony \
    HARMONY_CONDUCTOR_REMOTE=1

USER node
ENTRYPOINT ["/opt/harmony-plugin/container/conductor/entrypoint.sh"]
CMD ["node", "/opt/harmony-plugin/dist/bin/daemon.js"]
