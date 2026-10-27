FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --silent
COPY . .
RUN npm run build && npx esbuild scripts/figma-refresh-runner.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/figma-refresh-runner.js --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/figma-refresh-runner.js /app/dist/figma-refresh-runner.js
COPY --from=build /app/dist/THIRD_PARTY_NOTICES /app/dist/THIRD_PARTY_NOTICES
COPY .claude-plugin/plugin.json /app/.claude-plugin/plugin.json
USER node
ENTRYPOINT ["node", "/app/dist/figma-refresh-runner.js"]
