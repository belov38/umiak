# syntax=docker/dockerfile:1
# Owner ingress, bundled releases and gateway wrapper. Tool versions match mise.toml.
FROM golang:1.27.3-trixie AS gateway-build
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY libs/proto libs/proto
COPY libs/tunnel libs/tunnel
COPY services/gateway services/gateway
WORKDIR /src/services/gateway
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build -trimpath -ldflags '-s -w' -o /out/umiak-gateway ./cmd/umiak-gateway

FROM golang:1.27.3-trixie AS node-agent-build
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64
WORKDIR /src/services/node-agent
COPY services/node-agent .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build -trimpath -ldflags '-s -w' -o /out/umiak-node-linux-amd64 ./cmd/umiak-node

FROM golang:1.27.3-trixie AS guest-build
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY libs/proto libs/proto
COPY libs/tunnel libs/tunnel
COPY services/guest-agent services/guest-agent
WORKDIR /src/services/guest-agent
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w -X main.version=0.1.0+quickstart' -o /out/umiak-agent-linux-amd64 ./cmd/umiak-agent && GOOS=windows GOARCH=amd64 go build -trimpath -ldflags '-s -w -X main.version=0.1.0+quickstart' -o /out/umiak-agent-windows-amd64.exe ./cmd/umiak-agent && go build -trimpath -ldflags '-s -w' -o /out/umiak-release ./cmd/umiak-release

# A single manifest graph feeds production, compilation and CLI stages.
FROM node:26.13.0-bookworm-slim AS manifests
RUN npm install -g pnpm@12.16.1
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


FROM manifests AS production-deps
RUN pnpm install --frozen-lockfile --prod --filter-prod "@umiak/api..." --filter-prod "@umiak/worker..." --filter-prod "@umiak/mcp..." --filter-prod "@umiak/template-builder..." --filter-prod "@umiak/db..."

FROM manifests AS node-build
RUN pnpm install --frozen-lockfile --filter "@umiak/agent-client..." --filter-prod "@umiak/cli..." --filter "."
COPY packages/proto/src packages/proto/src
COPY packages/proto/tsconfig.json packages/proto/
COPY packages/agent-client/src packages/agent-client/src
COPY packages/agent-client/tsconfig.json packages/agent-client/tsconfig.build.json packages/agent-client/
COPY packages/auth/src packages/auth/src
COPY packages/sdk-ts/src packages/sdk-ts/src
COPY apps/mcp/src apps/mcp/src
COPY apps/cli/src apps/cli/src
COPY apps/cli/scripts/build.ts apps/cli/scripts/build.ts
COPY deploy/compose/canonical-fetch.mjs deploy/compose/canonical-fetch.mjs
RUN pnpm --filter @umiak/proto --filter @umiak/agent-client run build

FROM oven/bun:1.4.4 AS bun
FROM node-build AS cli-build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN cd apps/cli && bun scripts/build.ts --all
FROM node:26.13.0-bookworm-slim AS ui-fonts
WORKDIR /fonts
# Same font packages and versions as the dashboard; no network dependency at runtime.
RUN npm install --ignore-scripts --no-package-lock @fontsource-variable/inter@5.3.0 @fontsource-variable/funnel-display@5.3.0
# Trusted moonlight-web viewer for /desktop/<slug>/ on the owner origin. Same release
# and SHA256 as infra/templates/linux-desktop/versions.toml (a test keeps them equal).
# index.html and admin.html are dropped: the ingress serves stream.html only.
# moonlight-web is GPL-3.0: its license text (same upstream tag, pinned SHA256) and a
# SOURCE note ship next to the assets. Neither matches the viewer's static-file
# pattern, so they are in the image but never served. See THIRD_PARTY_NOTICES.md.
FROM buildpack-deps:trixie-curl AS moonlight-assets
ARG MOONLIGHT_WEB_VERSION=3.0.1
ARG MOONLIGHT_WEB_SHA256=a46acb1f663faaff9cd97abd9671fe049dd525bfe955e95f7b9f753cc2b99f1a
ARG MOONLIGHT_WEB_LICENSE_SHA256=8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b
WORKDIR /download
RUN curl -fsSL -o moonlight-web.tar.gz "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v${MOONLIGHT_WEB_VERSION}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${MOONLIGHT_WEB_SHA256}  moonlight-web.tar.gz" | sha256sum -c - \
 && tar -xzf moonlight-web.tar.gz package/static \
 && rm package/static/index.html package/static/admin.html \
 && mv package/static /moonlight-web \
 && curl -fsSL -o /moonlight-web/LICENSE "https://raw.githubusercontent.com/MrCreativ3001/moonlight-web-stream/v${MOONLIGHT_WEB_VERSION}/LICENSE" \
 && echo "${MOONLIGHT_WEB_LICENSE_SHA256}  /moonlight-web/LICENSE" | sha256sum -c - \
 && printf '%s\n' \
    "moonlight-web-stream ${MOONLIGHT_WEB_VERSION} (static web frontend), GPL-3.0 (see LICENSE)." \
    "Source: https://github.com/MrCreativ3001/moonlight-web-stream/tree/v${MOONLIGHT_WEB_VERSION}" \
    "Release tarball: https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v${MOONLIGHT_WEB_VERSION}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz" \
    "Tarball SHA256: ${MOONLIGHT_WEB_SHA256}" \
    "Changes: index.html and admin.html removed; files otherwise unmodified." \
    > /moonlight-web/SOURCE
# Runtime contains production closures and explicit runtime sources only.
FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl openssh-client ca-certificates xorriso gnupg git jq && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-deps /app/ ./
COPY packages/auth/src packages/auth/src
COPY packages/config/src packages/config/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/payload/src packages/payload/src
COPY packages/pve/src packages/pve/src
COPY packages/sdk-ts/src packages/sdk-ts/src
COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src
COPY apps/mcp/src apps/mcp/src
COPY apps/template-builder/src apps/template-builder/src
COPY --from=node-build /app/packages/proto/dist packages/proto/dist
COPY --from=node-build /app/packages/agent-client/dist packages/agent-client/dist
COPY db/migrations db/migrations
COPY infra/templates infra/templates
COPY deploy/compose/quickstart/*.mjs deploy/compose/quickstart/
COPY deploy/compose/quickstart/*.sh deploy/compose/quickstart/
COPY deploy/compose/quickstart/THIRD_PARTY_NOTICES.md deploy/compose/quickstart/
COPY deploy/compose/meta-proxy.mjs deploy/compose/canonical-fetch.mjs deploy/compose/release-channel.mjs deploy/compose/
COPY deploy/compose/quickstart/service-secrets.sh /service-secrets.sh
COPY deploy/compose/quickstart/bootstrap.sh /bootstrap.sh
COPY apps/web/src/app/globals.css apps/web/src/app/globals.css
COPY apps/web/public/brand/lockup-inter-light.svg apps/web/public/brand/lockup-inter-light.svg
RUN mkdir -p /app/quickstart-assets && cp deploy/compose/quickstart/install.sh /app/quickstart-assets/install.sh && ln -s /app/packages/db/node_modules/pg /app/node_modules/pg
COPY --from=cli-build /app/apps/cli/dist/ /app/quickstart-assets/
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 /app/quickstart-assets/inter.woff2
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/funnel-display/files/funnel-display-latin-wght-normal.woff2 /app/quickstart-assets/funnel.woff2
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/inter/LICENSE /app/quickstart-assets/LICENSE-Inter
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/funnel-display/LICENSE /app/quickstart-assets/LICENSE-Funnel
COPY --from=moonlight-assets /moonlight-web /app/quickstart-assets/moonlight-web
COPY --from=gateway-build /out/umiak-gateway /umiak-gateway
COPY --from=node-agent-build /out/umiak-node-linux-amd64 /app/quickstart-assets/umiak-node-linux-amd64
COPY --from=guest-build /out/umiak-agent-linux-amd64 /app/quickstart-assets/umiak-agent-linux-amd64
COPY --from=guest-build /out/umiak-agent-windows-amd64.exe /app/quickstart-assets/umiak-agent-windows-amd64.exe
COPY --from=guest-build /out/umiak-release /umiak-release
ARG UMIAK_PLATFORM_VERSION=0.1.0
ENV UMIAK_PLATFORM_VERSION=$UMIAK_PLATFORM_VERSION
ARG UMIAK_SOURCE_COMMIT=
ENV UMIAK_SOURCE_COMMIT=$UMIAK_SOURCE_COMMIT
ENV NODE_ENV=production UMIAK_QUICKSTART_PORT=4180 UMIAK_QUICKSTART_ASSETS=/app/quickstart-assets
COPY --chmod=755 deploy/compose/quickstart/umiak-signin /usr/local/bin/umiak-signin
USER node
EXPOSE 4180 4181
ENTRYPOINT ["node", "deploy/compose/quickstart/run.mjs"]
CMD ["node", "deploy/compose/quickstart/server.mjs"]
