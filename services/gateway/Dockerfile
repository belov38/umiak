# syntax=docker/dockerfile:1
# umiak-gateway image. Build context is the repo root:
#   docker build -f services/gateway/Dockerfile -t umiak-gateway:dev .
# Dockerfile.dockerignore next to this file replaces the root .dockerignore for
# this build and limits the context to the Go modules the gateway needs.
ARG GO_IMAGE=golang:1.27.3-trixie
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot

FROM ${GO_IMAGE} AS build
# The gateway module builds alone (no go.work) through its replace directives
# to ../../libs/tunnel and ../../libs/proto.
ENV GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY libs/proto/go.mod libs/proto/go.sum libs/proto/
COPY libs/tunnel/go.mod libs/tunnel/go.sum libs/tunnel/
COPY services/gateway/go.mod services/gateway/go.sum services/gateway/
WORKDIR /src/services/gateway
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY libs/proto /src/libs/proto
COPY libs/tunnel /src/libs/tunnel
COPY services/gateway /src/services/gateway
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/umiak-gateway ./cmd/umiak-gateway

FROM ${RUNTIME_IMAGE}
COPY --from=build /out/umiak-gateway /umiak-gateway
USER nonroot
# 8443 TLS (umiak and tunnel), 2222 SSH, 7000 internal (peers, api, worker),
# 9090 metrics and health.
EXPOSE 8443 2222 7000 9090
ENTRYPOINT ["/umiak-gateway"]
CMD ["serve"]
