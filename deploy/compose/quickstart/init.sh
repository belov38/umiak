#!/bin/sh
# Offline root bootstrap: preserve gateway identity before deriving service secrets.
set -eu
cd /app
node deploy/compose/quickstart/gateway-init.mjs
exec sh /bootstrap.sh
