# syntax=docker/dockerfile:1
# One-shot secrets bootstrap of the root compose.yaml (`secrets-init`). Build context: repo root.
FROM alpine:3.24.3
RUN apk add --no-cache openssh-keygen jq openssl
COPY deploy/compose/secrets-init/init.sh /legacy-init.sh
COPY deploy/compose/quickstart/bootstrap.sh /bootstrap.sh
ENTRYPOINT ["sh", "/bootstrap.sh"]
