FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npx esbuild src/bin/codex-auth.ts --bundle --platform=node --format=esm --target=node22 --outfile=codex-auth.js --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /build/codex-auth.js /app/codex-auth.mjs
USER 1000:1000
ENTRYPOINT ["node", "/app/codex-auth.mjs"]
CMD ["owner"]
