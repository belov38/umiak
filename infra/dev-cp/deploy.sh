#!/usr/bin/env bash
# umiak dev control plane: deploy the compose stack (deploy/compose) to CT 590.
# Runs on the operator's Mac. The CT is created by `infra/pve/setup.sh cp`. Dev only.
#
#   infra/dev-cp/deploy.sh [--dry-run]
#
# Copies the working tree (git ls-files, without ignored files) to umiak@<CT>:umiak,
# the PVE secrets and the dev CA (dev-ca.sh) to ~/.config/umiak on the CT (0600), writes
# deploy/compose/.env and the dev umiak.yaml, then runs `docker compose up -d --build`, waits for
# worker, gateway, api, oauth2-proxy, web and mcp, applies the Tailscale Serve mapping (names.sh) and
# checks the names and certificates from this Mac.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
CT="${UMIAK_DEVCP_SSH:-umiak@$CT_IP}"
PVE_LAN_IP="${UMIAK_PVE_LAN_IP:-192.168.68.116}"
# Compose files in deploy/compose; the dev override is always appended. compose.yaml has the S7
# services and includes gateway.yaml; add later files here (UMIAK_DEVCP_COMPOSE_FILES).
FILES="${UMIAK_DEVCP_COMPOSE_FILES:-compose.yaml:gateway.yaml}"
# Extra lines for deploy/compose/.env, e.g. UMIAK_DEVCP_ENV='UMIAK_API_LOG_LEVEL=debug'.
EXTRA_ENV="${UMIAK_DEVCP_ENV:-}"
CFG_DIR="${UMIAK_CONFIG_DIR:-$HOME/.config/umiak}"
DIR=umiak
REPO="$(cd "$HERE/../.." && pwd)"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY=1
	shift
fi
[[ $# -eq 0 ]] || {
	sed -n '2,11p' "$0"
	exit 2
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

# ct runs a bash script from stdin on the CT as umiak, in the repo copy.
ct() {
	local prefix=""
	local kv
	for kv in "$@"; do
		prefix+="export ${kv%%=*}=$(printf '%q' "${kv#*=}")"$'\n'
	done
	if ((DRY)); then
		printf -- '--- script on %s ---\n%s' "$CT" "$prefix"
		cat
		printf -- '--- end ---\n'
		return 0
	fi
	{
		printf '%sset -euo pipefail\nmkdir -p ~/%s && cd ~/%s\n' "$prefix" "$DIR" "$DIR"
		cat
	} | ssh -o BatchMode=yes "$CT" "python3 ~/umiak/infra/dev-cp/remote-script.py"
}

for f in pve-token pve-root-ca.pem umiak-node_ed25519 known_hosts; do
	[[ -s "$CFG_DIR/$f" ]] || die "$CFG_DIR/$f is missing (infra/pve/setup.sh user and node)"
done
if ((DRY)); then
	[[ -s "$CA_DIR/ca.pem" ]] || log "dry run: $CA_DIR/ca.pem is missing; dev-ca.sh creates it on a real run"
else
	"$HERE/dev-ca.sh"
	"$HERE/turn-cert.sh"
fi

# 1. The working tree: tracked and untracked files that are not ignored, minus deleted ones.
log "sync $REPO -> $CT:$DIR"
list_dir=$(mktemp -d)
list="$list_dir/files"
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$list_dir"' EXIT
(
	cd "$REPO"
	git ls-files -co --exclude-standard --deduplicate | grep -vxF -f <(git ls-files -d) >"$list"
)
log "$(wc -l <"$list" | tr -d ' ') files"
if ((DRY)); then
	echo "+ tar -C $REPO -T <list> | ssh $CT tar -x -C $DIR; remove files that are not in the list"
else
	# shellcheck disable=SC2016 # expanded on the CT
	COPYFILE_DISABLE=1 tar --no-xattrs -C "$REPO" -cf - -T "$list" |
		ssh -o BatchMode=yes "$CT" "mkdir -p ~/$DIR && tar -xf - -C ~/$DIR"
	# Remove what is gone from the tree; secrets and .env live only on the CT.
	ssh -o BatchMode=yes "$CT" "python3 ~/umiak/infra/dev-cp/prune.py" <"$list"
fi

# 2. PVE secrets and the dev CA, 0600, owned by umiak (uid 1000 = node in the worker image). The
# host key is pinned for the host LAN address too: the CT reaches the host over the LAN.
log "secrets -> $CT:.config/umiak"
if ((DRY)); then
	echo "+ copy pve-token pve-root-ca.pem umiak-node_ed25519 known_hosts (+ $PVE_LAN_IP) to $CT:.config/umiak, mode 0600"
	echo "+ copy dev-ca/ca.pem dev-ca/ca.key to $CT:.config/umiak/dev-ca, mode 0600"
else
	ssh -o BatchMode=yes "$CT" 'install -d -m 700 ~/.config ~/.config/umiak ~/.config/umiak/dev-ca'
	for f in pve-token pve-root-ca.pem umiak-node_ed25519 dev-ca/ca.pem dev-ca/ca.key; do
		src="$CFG_DIR/$f"
		[[ "$f" == dev-ca/* ]] && src="$CA_DIR/${f#dev-ca/}"
		ssh -o BatchMode=yes "$CT" "umask 077 && cat >~/.config/umiak/$f.new && mv ~/.config/umiak/$f.new ~/.config/umiak/$f" <"$src"
	done
	key=$(awk 'NF >= 3 {print $2, $3; exit}' "$CFG_DIR/known_hosts")
	[[ -n "$key" ]] || die "no host key in $CFG_DIR/known_hosts"
	{
		cat "$CFG_DIR/known_hosts"
		printf '%s %s\n' "$PVE_LAN_IP" "$key"
	} | ssh -o BatchMode=yes "$CT" 'umask 077 && cat >~/.config/umiak/known_hosts'
fi

if ((!DRY)); then
 ssh -o BatchMode=yes "$CT" 'install -d -m 700 ~/umiak/deploy/compose/secrets/turn'
 for f in tls.crt tls.key; do
  ssh -o BatchMode=yes "$CT" "umask 077; cat >~/umiak/deploy/compose/secrets/turn/$f" <"$CA_DIR/turn/$f"
 done
fi

# 3. The dev CA for the gateway, .env, the dev umiak.yaml, data keys; then the stack.
ct "TURN_HOST=$TURN_HOST" "TURN_IP=$CT_IP" "PVE_LAN_IP=$PVE_LAN_IP" "PORT_DOMAIN=$PORT_DOMAIN" "TUNNEL_HOST=$TUNNEL_HOST" "TUNNEL_URL=$TUNNEL_URL" \
	"TS_NAME=$TS_NAME" "SSH_HOST=$SSH_HOST" "APP_ORIGIN=$APP_ORIGIN" "API_URL=$API_URL" "MCP_URL=$MCP_URL" \
	"KEYCLOAK_URL=$KEYCLOAK_URL" "OIDC_ISSUER=$OIDC_ISSUER" "LOGOUT_URL=$LOGOUT_URL" "SERVE=$SERVE" \
	"FILES=$FILES" "EXTRA_ENV=$EXTRA_ENV" "AUTH_MODE=$AUTH_MODE" "CT_IP=$CT_IP" <<'EOF'
ts=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[ "$ts" = "$TS_NAME" ] || { echo "the CT's MagicDNS name is $ts, not $TS_NAME (set UMIAK_DEVCP_TS_NAME)" >&2; exit 1; }
cd deploy/compose
mkdir -p secrets/gateway secrets/devcp
# The gateway's dev-secrets issues the tunnel and *.umiak. certificates with the dev CA when they
# are missing. Start over when the CA or the names change, and renew within 30 days of expiry.
# The files belong to the gateway user after the first run; the directory is ours, so rm works.
gw=secrets/gateway
stamp="$(sha256sum ~/.config/umiak/dev-ca/ca.pem | cut -d' ' -f1) $TUNNEL_HOST $PORT_DOMAIN"
if [ "$(cat secrets/devcp/gateway-tls.stamp 2>/dev/null)" != "$stamp" ]; then
	echo "gateway TLS: dev CA $(openssl x509 -in ~/.config/umiak/dev-ca/ca.pem -noout -subject), names $TUNNEL_HOST *.$PORT_DOMAIN"
	python3 -c 'from pathlib import Path; import sys; [Path(p).unlink(missing_ok=True) for p in sys.argv[1:]]' "$gw"/ca.pem "$gw"/ca.key "$gw"/umiak.pem "$gw"/umiak.key "$gw"/tunnel.pem "$gw"/tunnel.key
	install -m 644 ~/.config/umiak/dev-ca/ca.pem "$gw/ca.pem"
	install -m 600 ~/.config/umiak/dev-ca/ca.key "$gw/ca.key"
	printf '%s\n' "$stamp" >secrets/devcp/gateway-tls.stamp
fi
for c in umiak tunnel; do
	if [ -s "$gw/$c.pem" ] && ! openssl x509 -in "$gw/$c.pem" -noout -checkend $((30 * 86400)) >/dev/null; then
		echo "gateway TLS: $c.pem expires within 30 days, renewing"
		python3 -c 'from pathlib import Path; import sys; [Path(p).unlink(missing_ok=True) for p in sys.argv[1:]]' "$gw/$c.pem" "$gw/$c.key"
	fi
done
sed -E "s#^( *apiUrl:).*#\1 https://$PVE_LAN_IP:8006#" config/umiak.yaml >secrets/devcp/umiak.yaml
grep -q "apiUrl: https://$PVE_LAN_IP:8006" secrets/devcp/umiak.yaml
if [ ! -s secrets/data-keys.json ]; then
	(umask 077 && printf '{"current":1,"keys":{"1":"%s"}}\n' "$(head -c 32 /dev/urandom | base64)" >secrets/data-keys.json)
fi
# Stand-only passwords are regenerated only for a fresh deployment, never on a redeploy.
for name in postgres-password dev-user-password; do
 if [ ! -s "secrets/devcp/$name" ]; then
  (umask 077; openssl rand -hex 32 >"secrets/devcp/$name")
 fi
done
umask 077
cat >.env <<ENV
# Written by infra/dev-cp/deploy.sh; changes are overwritten on the next deploy.
COMPOSE_FILE=$FILES:../../infra/dev-cp/compose.dev-cp.yaml
COMPOSE_PROFILES=desktop
UMIAK_AUTH_MODE=$AUTH_MODE
UMIAK_DEVCP_DB_PASSWORD=$(cat secrets/devcp/postgres-password)
UMIAK_DEVCP_USER_PASSWORD=$(cat secrets/devcp/dev-user-password)
UMIAK_CP_IP=$CT_IP
UMIAK_DEVCP_TURN_IP=$TURN_IP
UMIAK_DEVCP_TURN_HOST=$TURN_HOST
# Dev TURN on the CT address (README): TLS on 5349 (443 is the gateway), relay ports above
# the ephemeral range (32768-60999) and never published.
UMIAK_TURN_IP=$TURN_IP
UMIAK_TURN_REALM=$TURN_HOST
UMIAK_TURN_PORT=3478
UMIAK_TURN_TLS_PORT=5349
UMIAK_TURN_RELAY_MIN=61000
UMIAK_TURN_RELAY_MAX=61040
# The entrypoint is bind-mounted: a new hash recreates turn on deploy (turn.yaml label).
UMIAK_TURN_ENTRYPOINT_SHA256=$(sha256sum turn/entrypoint.sh | cut -d' ' -f1)
UMIAK_DEVCP_TURN_URLS=turn:$TURN_HOST:3478?transport=udp,turn:$TURN_HOST:3478?transport=tcp,turns:$TURN_HOST:5349?transport=tcp
# The PVE host over the LAN. migrate (bootstrap) loads the API URL from secrets/devcp/umiak.yaml.
UMIAK_PVE_URL=https://$PVE_LAN_IP:8006
UMIAK_PVE_TLS_NAME=pve
UMIAK_NODE_SSH_HOST=$PVE_LAN_IP
UMIAK_PVE_SECRETS_DIR=$HOME/.config/umiak
# Names (infra/dev-cp/names.sh). Agents: the tunnel host on the LAN address (dev CA). Previews:
# *.UMIAK_PORT_DOMAIN on the tailnet address (dev CA). The rest through Tailscale Serve on the
# CT's MagicDNS name (Let's Encrypt).
UMIAK_DEVCP_TUNNEL_HOST=$TUNNEL_HOST
UMIAK_TUNNEL_URL=$TUNNEL_URL
UMIAK_PORT_DOMAIN=$PORT_DOMAIN
UMIAK_DEVCP_SSH_HOST=$SSH_HOST
# Public URLs behind Tailscale Serve: api, Keycloak, oauth2-proxy and the gateway's port SSO
# (compose.dev-cp.yaml; README "S7 behind Tailscale Serve").
UMIAK_DEVCP_TS_NAME=$TS_NAME
UMIAK_APP_ORIGIN=$APP_ORIGIN
UMIAK_API_PUBLIC_URL=$API_URL
UMIAK_MCP_PUBLIC_URL=$MCP_URL
UMIAK_KEYCLOAK_URL=$KEYCLOAK_URL
UMIAK_OIDC_ISSUER=$OIDC_ISSUER
UMIAK_GATEWAY_AUTH_URL=$APP_ORIGIN/umiak-auth/authorize
UMIAK_OAUTH2_PROXY_REDIRECT_URL=$APP_ORIGIN/oauth2/callback
UMIAK_LOGOUT_URL=$LOGOUT_URL
$EXTRA_ENV
ENV
if [ "$AUTH_MODE" = none ]; then
 cat >>.env <<LOCAL
COMPOSE_FILE=$FILES:../../infra/dev-cp/compose.dev-cp.yaml:local.yaml:../../infra/dev-cp/compose.local.yaml
UMIAK_LOCAL_BIND=$CT_IP
UMIAK_LOCAL_ALLOWED_CIDRS=127.0.0.0/8,::1/128,192.168.68.0/24,172.18.0.0/16
UMIAK_LOCAL_DENIED_CIDRS=$PVE_LAN_IP/32,10.88.0.0/24
UMIAK_LOCAL_INGRESS_IP=172.18.255.10
UMIAK_LOCAL_MCP_IP=172.18.255.11
LOCAL
fi
chmod 600 .env
docker compose config --quiet
# The one-time switch to S8 (identities move from the schema identity to payload): the pre-S8 api
# and worker keep writing into identity while web-migrate copies it, and later rows would be lost.
# Stop them first when the stack runs and has identity but no Payload migrations yet; any later
# deploy finds payload.payload_migrations and skips this. Images are built first, so a failed
# build leaves the running api and worker alone.
docker compose build 2>&1 | grep -vE '^ *#[0-9]+ ' | tail -30
if [ -n "$(docker compose ps -q --status running postgres)" ]; then
	first_s8=$(docker compose exec -T postgres psql -U umiak -d umiak -tAc \
		"SELECT to_regclass('identity.users') IS NOT NULL AND to_regclass('payload.payload_migrations') IS NULL")
	if [ "$first_s8" = t ]; then
		echo "first S8 deploy: stopping api and worker before web-migrate copies identity into payload"
		docker compose stop api worker
	fi
fi
if [ "$AUTH_MODE" = none ]; then
 docker compose --profile excluded-oidc stop keycloak keycloak-db oauth2-proxy
fi
docker compose up -d --remove-orphans 2>&1 | tail -30
# api and oauth2-proxy wait for Keycloak, whose first start (realm import) takes a minute or two;
# api, worker and web wait for migrate and web-migrate.
healthy() {
	local s
	local services="worker gateway api web mcp turn"
 [ "$AUTH_MODE" = none ] || services="$services oauth2-proxy"
 for s in $services; do
		[ "$(docker compose ps --format '{{.Health}}' "$s")" = healthy ] || return 1
	done
}
for _ in $(seq 1 150); do
	healthy && break
	sleep 2
done
docker compose ps -a --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
echo "worker /readyz: $(curl -sS http://127.0.0.1:9090/readyz)"
echo "gateway /readyz: $(curl -sS http://127.0.0.1:9190/readyz)"
echo "api /readyz: $(curl -sS http://127.0.0.1:9091/readyz)"
echo "mcp /readyz: $(curl -sS http://127.0.0.1:9092/readyz)"
healthy

# Tailscale Serve (operator umiak, set by `infra/pve/setup.sh cp-tailscale`): rebuilt from SERVE.
# Serve takes its ports on the tailnet address before Docker sees them; 443 stays with the gateway.
tailscale serve reset
for m in $SERVE; do
	port=${m%%:*} rest=${m#*:}
	path=${rest%%=*} target=${rest#*=}
	[ "$port" != 443 ] || { echo "SERVE: 443 belongs to the gateway (previews)" >&2; exit 1; }
	tailscale serve --bg --yes --https="$port" --set-path="$path" "$target" >/dev/null
done
tailscale serve status
EOF
((DRY)) && exit 0

# 4. From this Mac. The tunnel host (LAN address, so only from the LAN) and a preview host
# (tailnet address) with the dev CA: without api a preview answers 503 route_lookup_unavailable,
# with api 404 route_not_found; either proves DNS, TLS and routing. Serve with the system trust
# store: oauth2-proxy on 8443 (a sign-in redirect), Keycloak on 10000, and /v1/meta of the api
# public listener on 8443.
# check name url [curl args]: logs the HTTP status and the body; any HTTP answer passes
# (CHECK_CODE keeps the status).
check() {
	local name=$1 url=$2 out
	shift 2
	out=$(curl -sS --max-time 30 -w '\n%{http_code}' "$@" "$url" 2>&1) || true
	CHECK_CODE=${out##*$'\n'}
	log "$name $url: HTTP $CHECK_CODE ${out%$'\n'*}"
	[[ "$CHECK_CODE" =~ ^[0-9]{3}$ && "$CHECK_CODE" != 000 ]]
}
# check_ok name url [curl args]: like check, but only HTTP 200 passes (a 421 for a Host the
# server does not take, or a 404 of a missing Serve path, must not).
check_ok() { check "$@" && [[ "$CHECK_CODE" == 200 ]]; }
# Protected Resource Metadata of MCP_URL (RFC 9728): the well-known prefix before its path.
MCP_ORIGIN=$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$MCP_URL")
MCP_PRM_URL="$MCP_ORIGIN/.well-known/oauth-protected-resource${MCP_URL#"$MCP_ORIGIN"}"
check tunnel "https://$TUNNEL_HOST/v1/connect" --cacert "$CA_DIR/ca.pem" ||
	log "WARNING: the tunnel host is not reachable from this Mac (outside the LAN?)"
check preview "https://x-y-z-3000.$PORT_DOMAIN/" --cacert "$CA_DIR/ca.pem" ||
	log "WARNING: the preview host is not reachable from this Mac (not on the tailnet?)"
for port in $(tr ' ' '\n' <<<"$SERVE" | cut -d: -f1 | sort -u); do
	check serve "https://$TS_NAME:$port/" -o /dev/null ||
		log "WARNING: Tailscale Serve on $TS_NAME:$port is not reachable from this Mac"
done
check api "$API_URL/v1/meta" ||
	log "WARNING: the api is not reachable through Tailscale Serve from this Mac"
if [[ "$AUTH_MODE" = none ]]; then
 check_ok dashboard "$APP_ORIGIN/app" -L -o /dev/null
else
check_ok mcp "$MCP_PRM_URL" ||
	log "WARNING: the MCP server is not reachable through Tailscale Serve from this Mac"
fi
log "deployed ($AUTH_MODE)"
