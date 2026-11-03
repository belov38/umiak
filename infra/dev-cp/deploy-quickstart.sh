#!/usr/bin/env bash
# S16 on the existing CT590. Does not touch PVE objects or firewall.
# Roll back: UMIAK_DEVCP_AUTH_MODE=none|oidc infra/dev-cp/deploy.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
ct_host=${UMIAK_DEVCP_SSH:-umiak@100.64.10.7}
"$here/quickstart-preflight.sh"
file_dir=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$file_dir"' EXIT
cd "$repo"
git ls-files -co --exclude-standard --deduplicate >"$file_dir/files"
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -T "$file_dir/files" |
 ssh -o BatchMode=yes "$ct_host" 'mkdir -p ~/umiak && tar -xf - -C ~/umiak'
ssh -o BatchMode=yes "$ct_host" "python3 ~/umiak/infra/dev-cp/remote-script.py" <<'REMOTE'
set -euo pipefail
cd ~/umiak
umask 077
mkdir -p deploy/compose/secrets/devcp/quickstart-db
cp -n deploy/compose/secrets/devcp/postgres-password deploy/compose/secrets/devcp/quickstart-db/password
# Preserve exact S15 TLS files and deployment settings for audit/rollback.
sha256sum deploy/compose/secrets/gateway/{ca,tunnel,umiak}.pem >deploy/compose/secrets/devcp/s16-tls-before.sha256
cp -n deploy/compose/.env deploy/compose/secrets/devcp/s15.env
compose=(docker compose --env-file deploy/compose/.env -f compose.yaml -f infra/dev-cp/compose.quickstart.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" build secrets-init migrate web-migrate api mcp gateway-secrets quickstart
# Prevent the old unauthenticated ingress from bypassing owner gate.
(cd deploy/compose && docker compose stop local-ingress)
"${compose[@]}" up -d
sha256sum -c deploy/compose/secrets/devcp/s16-tls-before.sha256
tailscale serve --bg --https=8443 http://localhost:4181
"${compose[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
echo 'Retrieve setup code privately with: docker compose --env-file deploy/compose/.env -f compose.yaml -f infra/dev-cp/compose.quickstart.yaml logs quickstart'
echo 'Owner URL: https://umiak-dev-cp.tail0000.ts.net:8443 (publicly trusted Serve TLS)'
echo 'LAN URL: http://192.168.68.90:4180'
REMOTE
