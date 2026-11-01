# Worker image. Build context is the repo root:
#   docker build -f apps/worker/Dockerfile .
# The worker's own packages need no build: Node 26 strips TypeScript types at
# runtime. S2's @umiak/proto and @umiak/agent-client are compiled to `dist` in the
# build stage (their package exports point there at runtime).
ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Node 26 no longer ships corepack; install the pnpm version pinned in package.json.
ARG PNPM_VERSION=12.16.1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
# Workspace manifests first, so the install layers are cached across source edits.
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
COPY apps/worker/package.json apps/worker/
# Part of the workspace and the lockfile, but not of the worker closure.
COPY apps/api/package.json apps/api/
COPY apps/bench/package.json apps/bench/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/template-builder/package.json apps/template-builder/
COPY apps/web/package.json apps/web/

# ---- build: compile @umiak/proto and @umiak/agent-client (needs dev dependencies)
FROM base AS build
# The workspace root brings typescript and @types/node.
RUN pnpm install --frozen-lockfile --filter "@umiak/agent-client..." --filter "."
COPY packages/proto/tsconfig.json packages/proto/
COPY packages/proto/src packages/proto/src
COPY packages/agent-client/tsconfig.json packages/agent-client/tsconfig.build.json packages/agent-client/
COPY packages/agent-client/src packages/agent-client/src
# Only these two: "@umiak/agent-client..." also selects its dev dependencies
# (@umiak/db for the test Postgres guard), whose sources are not copied here.
RUN pnpm --filter "@umiak/proto" --filter "@umiak/agent-client" run build

# ---- runtime: production dependencies only
FROM base
RUN pnpm install --frozen-lockfile --prod --filter "@umiak/worker..."

COPY db/migrations db/migrations
COPY --from=build /app/packages/proto/dist packages/proto/dist
COPY --from=build /app/packages/agent-client/dist packages/agent-client/dist
COPY packages/auth/src packages/auth/src
COPY packages/config/src packages/config/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
# Payload config, collections and migrations (identity and config, S8).
COPY packages/payload/src packages/payload/src
COPY packages/pve/src packages/pve/src
COPY apps/worker/src apps/worker/src

ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/src/main.ts"]
