FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --silent
COPY . .
RUN npm run build && npx esbuild scripts/figma-refresh-runner.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/figma-refresh-runner.js --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
FROM node:22-bookworm-slim
# B-1337: container/figma/cloudbuild.yaml passes both; container/figma/smoke.sh checks the version label.
ARG PLUGIN_VERSION=unknown
ARG SOURCE_COMMIT=unknown
LABEL harmony.plugin_version="${PLUGIN_VERSION}" \
      harmony.source_commit="${SOURCE_COMMIT}"
WORKDIR /app
COPY --from=build /app/dist/figma-refresh-runner.js /app/dist/figma-refresh-runner.js
COPY --from=build /app/dist/THIRD_PARTY_NOTICES /app/dist/THIRD_PARTY_NOTICES
COPY .claude-plugin/plugin.json /app/.claude-plugin/plugin.json
USER node
ENTRYPOINT ["node", "/app/dist/figma-refresh-runner.js"]
