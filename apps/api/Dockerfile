# Build context: repository root.  docker compose --profile app up --build
FROM node:22.20.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun@1.4.2
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN bun run --filter @pegpal/shared build \
  && cd apps/api && bunx prisma generate && bun run build

FROM node:22.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/api
USER node
EXPOSE 3001
# Migrations are applied on start; the app itself refuses to boot with invalid config.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
