# Remote MCP server image (S11). Build context is the repo root:
#   docker build -f apps/mcp/Dockerfile -t sbx-mcp:dev .
# Nothing is built: Node 26 strips TypeScript types at runtime, and the only
# workspace package at runtime is @sbx/sdk (also plain TypeScript, no build
# step). So there is no build stage, unlike the api image.
ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Node 26 no longer ships corepack; install the pnpm version pinned in package.json.
ARG PNPM_VERSION=12.16.1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
# Every workspace manifest (the lockfile covers all of them), first, so the
# install layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig.base.json ./
COPY packages/agent-client/package.json packages/agent-client/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/proto/package.json packages/proto/
COPY packages/pve/package.json packages/pve/
COPY packages/sdk-py/package.json packages/sdk-py/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY apps/api/package.json apps/api/
COPY apps/bench/package.json apps/bench/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/template-builder/package.json apps/template-builder/
COPY apps/worker/package.json apps/worker/

# ---- runtime: production dependencies of @sbx/mcp and @sbx/sdk only
# (@sbx/api, @sbx/core and @sbx/db are dev dependencies of the tests).
FROM base
RUN pnpm install --frozen-lockfile --prod --filter "@sbx/mcp..."

COPY packages/sdk-ts/src packages/sdk-ts/src
COPY apps/mcp/src apps/mcp/src

ENV NODE_ENV=production
USER node
# main (/mcp, metadata), ops (/metrics, /healthz, /readyz)
EXPOSE 8080 9090
# SIGTERM: graceful stop within 25 s (compose stop_grace_period and pod grace 30 s).
CMD ["node", "apps/mcp/src/main.ts"]
