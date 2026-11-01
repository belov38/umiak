# E2E backend image (test only; S8 plan decision 10). Build context is the
# repo root:
#   docker build -f apps/web/e2e/backend/Dockerfile .
# The api and worker sources plus the worker's test fakes, run as one
# process by apps/web/e2e/backend/main.ts. Never deployed: compose uses it
# only through deploy/compose/e2e.yaml. The context filter is
# Dockerfile.dockerignore next to this file (the root .dockerignore keeps
# apps/web/e2e out of every other image).
ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.16.1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
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
COPY apps/api/package.json apps/api/
COPY apps/bench/package.json apps/bench/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/template-builder/package.json apps/template-builder/
COPY apps/web/package.json apps/web/

# ---- build: compile @umiak/proto and @umiak/agent-client (needs dev dependencies)
FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@umiak/agent-client..." --filter "."
COPY packages/proto/tsconfig.json packages/proto/
COPY packages/proto/src packages/proto/src
COPY packages/agent-client/tsconfig.json packages/agent-client/tsconfig.build.json packages/agent-client/
COPY packages/agent-client/src packages/agent-client/src
RUN pnpm --filter "@umiak/proto" --filter "@umiak/agent-client" run build

# ---- runtime: production dependencies of the api and the worker
FROM base
RUN pnpm install --frozen-lockfile --prod --filter "@umiak/api..." --filter "@umiak/worker..."

COPY db/migrations db/migrations
COPY --from=build /app/packages/proto/dist packages/proto/dist
COPY --from=build /app/packages/agent-client/dist packages/agent-client/dist
COPY packages/auth/src packages/auth/src
COPY packages/config/src packages/config/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/payload/src packages/payload/src
COPY packages/pve/src packages/pve/src
COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src
COPY apps/worker/test/fakes apps/worker/test/fakes
COPY apps/web/e2e/backend apps/web/e2e/backend

ENV NODE_ENV=production
USER node
# public, proxied, internal, ops (as the api), worker http, control
EXPOSE 8080 8081 8082 9090 9095 9099
CMD ["node", "apps/web/e2e/backend/main.ts"]
