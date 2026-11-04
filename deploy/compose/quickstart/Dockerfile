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

FROM golang:1.27.3-trixie AS node-build
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

FROM oven/bun:1.4.4 AS bun
FROM node:26.13.0-bookworm-slim AS cli-build
RUN npm install -g pnpm@12.16.1
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter-prod "@umiak/cli..."
RUN cd apps/cli && bun scripts/build.ts --all
FROM node:26.13.0-bookworm-slim AS ui-fonts
WORKDIR /fonts
# Same font packages and versions as the dashboard; no network dependency at runtime.
RUN npm install --ignore-scripts --no-package-lock @fontsource-variable/inter@5.3.0 @fontsource-variable/funnel-display@5.3.0
# Trusted moonlight-web viewer for /desktop/<slug>/ on the owner origin. Same release
# and SHA256 as infra/templates/linux-desktop/versions.toml (a test keeps them equal).
# index.html and admin.html are dropped: the ingress serves stream.html only.
FROM buildpack-deps:trixie-curl AS moonlight-assets
ARG MOONLIGHT_WEB_VERSION=3.0.1
ARG MOONLIGHT_WEB_SHA256=a46acb1f663faaff9cd97abd9671fe049dd525bfe955e95f7b9f753cc2b99f1a
WORKDIR /download
RUN curl -fsSL -o moonlight-web.tar.gz "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v${MOONLIGHT_WEB_VERSION}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${MOONLIGHT_WEB_SHA256}  moonlight-web.tar.gz" | sha256sum -c - \
 && tar -xzf moonlight-web.tar.gz package/static \
 && rm package/static/index.html package/static/admin.html \
 && mv package/static /moonlight-web
# Keep build dependencies and other workspace applications out of the shipped image.
FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl openssh-client ca-certificates xorriso gnupg git && apt-get clean
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter-prod "@umiak/template-builder..." --filter-prod "@umiak/db..."
RUN mkdir -p /app/quickstart-assets && cp deploy/compose/quickstart/install.sh /app/quickstart-assets/install.sh && ln -s /app/packages/db/node_modules/pg /app/node_modules/pg
COPY --from=cli-build /app/apps/cli/dist/ /app/quickstart-assets/
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 /app/quickstart-assets/inter.woff2
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/funnel-display/files/funnel-display-latin-wght-normal.woff2 /app/quickstart-assets/funnel.woff2
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/inter/LICENSE /app/quickstart-assets/LICENSE-Inter
COPY --from=ui-fonts /fonts/node_modules/@fontsource-variable/funnel-display/LICENSE /app/quickstart-assets/LICENSE-Funnel
COPY --from=moonlight-assets /moonlight-web /app/quickstart-assets/moonlight-web
COPY --from=gateway-build /out/umiak-gateway /umiak-gateway
COPY --from=node-build /out/umiak-node-linux-amd64 /app/quickstart-assets/umiak-node-linux-amd64
COPY --from=guest-build /out/umiak-agent-linux-amd64 /app/quickstart-assets/umiak-agent-linux-amd64
COPY --from=guest-build /out/umiak-agent-windows-amd64.exe /app/quickstart-assets/umiak-agent-windows-amd64.exe
COPY --from=guest-build /out/umiak-release /umiak-release
ENV NODE_ENV=production UMIAK_QUICKSTART_PORT=4180 UMIAK_QUICKSTART_ASSETS=/app/quickstart-assets
COPY --chmod=755 deploy/compose/quickstart/umiak-signin /usr/local/bin/umiak-signin
USER node
EXPOSE 4180 4181
ENTRYPOINT ["node", "deploy/compose/quickstart/run.mjs"]
CMD ["node", "deploy/compose/quickstart/server.mjs"]
