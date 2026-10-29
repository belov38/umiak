# Worker image. Build context is the repo root:
#   docker build -f apps/worker/Dockerfile .
# No build step: Node 26 strips TypeScript types at runtime.
FROM node:26.13.0-bookworm-slim

# Node 26 no longer ships corepack; install the pnpm version pinned in package.json.
ARG PNPM_VERSION=12.16.1
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version

WORKDIR /app

# Workspace manifests first, so the install layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/pve/package.json packages/pve/
COPY apps/worker/package.json apps/worker/
# Part of the workspace and the lockfile, but not of the worker closure.
COPY apps/bench/package.json apps/bench/

RUN pnpm install --frozen-lockfile --prod --filter "@sbx/worker..."

COPY db/migrations db/migrations
COPY packages/config/src packages/config/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/pve/src packages/pve/src
# TEMPORARY (decision 16): stand-in for S2's tunnel migration, removed after the S2 merge.
COPY packages/db/test/fixtures packages/db/test/fixtures
COPY apps/worker/src apps/worker/src

ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/src/main.ts"]
