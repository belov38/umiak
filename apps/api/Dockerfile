# api image. Build context is the repo root:
#   docker build -f apps/api/Dockerfile .
# The api's own packages need no build: Node 26 strips TypeScript types at
# runtime. S2's @sbx/proto and @sbx/agent-client are compiled to `dist` in the
# build stage (their package exports point there at runtime).
ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Node 26 no longer ships corepack; install the pnpm version pinned in package.json.
ARG PNPM_VERSION=12.16.1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
# Every workspace manifest (the lockfile covers all of them), first, so the
# install layers are cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig.base.json ./
COPY packages/agent-client/package.json packages/agent-client/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/payload/package.json packages/payload/
COPY packages/proto/package.json packages/proto/
COPY packages/pve/package.json packages/pve/
COPY packages/sdk-py/package.json packages/sdk-py/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY apps/api/package.json apps/api/
COPY apps/bench/package.json apps/bench/
COPY apps/cli/package.json apps/cli/
COPY apps/template-builder/package.json apps/template-builder/
COPY apps/worker/package.json apps/worker/

# ---- build: compile @sbx/proto and @sbx/agent-client (needs dev dependencies)
FROM base AS build
# The workspace root brings typescript and @types/node.
RUN pnpm install --frozen-lockfile --filter "@sbx/agent-client..." --filter "."
COPY packages/proto/tsconfig.json packages/proto/
COPY packages/proto/src packages/proto/src
COPY packages/agent-client/tsconfig.json packages/agent-client/tsconfig.build.json packages/agent-client/
COPY packages/agent-client/src packages/agent-client/src
# Only these two: "@sbx/agent-client..." also selects its dev dependencies
# (@sbx/db for the test Postgres guard), whose sources are not copied here.
RUN pnpm --filter "@sbx/proto" --filter "@sbx/agent-client" run build

# ---- runtime: production dependencies only
FROM base
RUN pnpm install --frozen-lockfile --prod --filter "@sbx/api..."

COPY --from=build /app/packages/proto/dist packages/proto/dist
COPY --from=build /app/packages/agent-client/dist packages/agent-client/dist
COPY packages/auth/src packages/auth/src
COPY packages/config/src packages/config/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
# Payload config, collections and migrations (identity and config, S8).
COPY packages/payload/src packages/payload/src
COPY packages/pve/src packages/pve/src
COPY apps/api/src apps/api/src

ENV NODE_ENV=production
USER node
# public, proxied, internal, ops
EXPOSE 8080 8081 8082 9090
# SIGTERM: graceful stop within 10 s (compose stop_grace_period, pod grace 30 s).
CMD ["node", "apps/api/src/main.ts"]
