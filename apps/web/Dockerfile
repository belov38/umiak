# web image (S8 §14.1). Build context is the repo root:
#   docker build -f apps/web/Dockerfile .
# Two programs in one image:
#   - the Next.js server (standalone output), the default command;
#   - the payload migration job (web-migrate, S8 §12):
#       node packages/payload/src/migrate.ts   (WORKDIR /app/migrate)
# The dev auth stand-in (apps/web/dev) is never copied; `check-image.ts`
# fails the build if any of it reaches the output.
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
COPY apps/mcp/package.json apps/mcp/
COPY apps/template-builder/package.json apps/template-builder/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

# ---- build: next build (standalone)
FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@umiak/web..." --filter "."
COPY packages/auth/src packages/auth/src
COPY packages/config/src packages/config/src
COPY packages/payload/src packages/payload/src
COPY packages/sdk-ts/src packages/sdk-ts/src
COPY apps/web/tsconfig.json apps/web/next.config.ts apps/web/postcss.config.mjs apps/web/components.json apps/web/check-image.ts apps/web/
COPY apps/web/src apps/web/src
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@umiak/web" run build \
	&& node apps/web/check-image.ts

# ---- migrate: production dependencies of @umiak/payload (plain Node, type stripping)
FROM base AS migrate
RUN pnpm install --frozen-lockfile --prod --filter "@umiak/payload..."

# ---- runtime
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0
# Migration job: node_modules of the payload closure, then its sources.
WORKDIR /app/migrate
COPY --from=migrate /app/package.json ./
COPY --from=migrate /app/node_modules node_modules
COPY --from=migrate /app/packages/auth/node_modules packages/auth/node_modules
COPY --from=migrate /app/packages/config/node_modules packages/config/node_modules
COPY --from=migrate /app/packages/payload/node_modules packages/payload/node_modules
COPY packages/auth/package.json packages/auth/
COPY packages/auth/src packages/auth/src
COPY packages/config/package.json packages/config/
COPY packages/config/src packages/config/src
COPY packages/payload/package.json packages/payload/
COPY packages/payload/src packages/payload/src
# Web server: the standalone output with its static files.
WORKDIR /app/web
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY apps/web/healthcheck.js apps/web/
WORKDIR /app/web/apps/web
USER node
EXPOSE 3000
# Exec probe (S8 §5.1): `node healthcheck.js`.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD ["node", "healthcheck.js"]
CMD ["node", "server.js"]
