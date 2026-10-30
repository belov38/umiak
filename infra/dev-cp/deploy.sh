#!/usr/bin/env bash
# boat-dev-clone dev control plane: deploy the compose stack (deploy/compose) to CT 590.
# Runs on the operator's Mac. The CT is created by `infra/pve/setup.sh cp`. Dev only.
#
#   infra/dev-cp/deploy.sh [--dry-run]
#
# Copies the working tree (git ls-files, without ignored files) to sbx@<CT>:boat-dev-clone,
# the PVE secrets to ~/.config/sbx on the CT (0600), writes deploy/compose/.env and the dev
# sbx.yaml, then runs `docker compose up -d --build` and waits for worker and gateway.
set -euo pipefail

CT_IP="${SBX_CP_IP:-192.168.68.90}"
CT="${SBX_DEVCP_SSH:-sbx@$CT_IP}"
PVE_LAN_IP="${SBX_PVE_LAN_IP:-192.168.68.116}"
DOMAIN="${SBX_DEVCP_DOMAIN:-devcp.internal}"
# Compose files in deploy/compose; the dev override is always appended. Add later services
# (S7 api, S8 web, ...) here, e.g. SBX_DEVCP_COMPOSE_FILES=compose.yaml:gateway.yaml:api.yaml.
FILES="${SBX_DEVCP_COMPOSE_FILES:-compose.yaml:gateway.yaml}"
# Extra lines for deploy/compose/.env, e.g. SBX_DEVCP_ENV='SBX_GATEWAY_API_URL=http://api:8082'.
EXTRA_ENV="${SBX_DEVCP_ENV:-}"
CFG_DIR="${SBX_CONFIG_DIR:-$HOME/.config/sbx}"
DIR=boat-dev-clone
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY=1
	shift
fi
[[ $# -eq 0 ]] || {
	sed -n '2,9p' "$0"
	exit 2
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

# ct runs a bash script from stdin on the CT as sbx, in the repo copy.
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
	} | ssh -o BatchMode=yes "$CT" 'f=$(mktemp); cat >"$f"; bash "$f" </dev/null; rc=$?; rm -f "$f"; exit $rc'
}

for f in pve-token pve-root-ca.pem sbx-node_ed25519 known_hosts; do
	[[ -s "$CFG_DIR/$f" ]] || die "$CFG_DIR/$f is missing (infra/pve/setup.sh user and node)"
done

# 1. The working tree: tracked and untracked files that are not ignored, minus deleted ones.
log "sync $REPO -> $CT:$DIR"
list=$(mktemp)
trap 'rm -f "$list"' EXIT
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
	ssh -o BatchMode=yes "$CT" "cd ~/$DIR && f=\$(mktemp) && sort >\"\$f\" && find . -type f ! -path './deploy/compose/secrets/*' ! -path './deploy/compose/.env' | sed 's|^\./||' | sort | comm -23 - \"\$f\" | tee /dev/stderr | xargs -r -d '\n' rm -f && rm -f \"\$f\"" <"$list"
fi

# 2. PVE secrets, 0600, owned by sbx (uid 1000 = node in the worker image). The host key is
# pinned for the host LAN address too: the CT reaches the host over the LAN.
log "secrets -> $CT:.config/sbx"
if ((DRY)); then
	echo "+ copy pve-token pve-root-ca.pem sbx-node_ed25519 known_hosts (+ $PVE_LAN_IP) to $CT:.config/sbx, mode 0600"
else
	ssh -o BatchMode=yes "$CT" 'install -d -m 700 ~/.config ~/.config/sbx'
	for f in pve-token pve-root-ca.pem sbx-node_ed25519; do
		ssh -o BatchMode=yes "$CT" "umask 077 && cat >~/.config/sbx/$f.new && mv ~/.config/sbx/$f.new ~/.config/sbx/$f" <"$CFG_DIR/$f"
	done
	key=$(awk 'NF >= 3 {print $2, $3; exit}' "$CFG_DIR/known_hosts")
	[[ -n "$key" ]] || die "no host key in $CFG_DIR/known_hosts"
	{
		cat "$CFG_DIR/known_hosts"
		printf '%s %s\n' "$PVE_LAN_IP" "$key"
	} | ssh -o BatchMode=yes "$CT" 'umask 077 && cat >~/.config/sbx/known_hosts'
fi

# 3. .env, the dev sbx.yaml, data keys; then the stack.
ct "PVE_LAN_IP=$PVE_LAN_IP" "DOMAIN=$DOMAIN" "FILES=$FILES" "EXTRA_ENV=$EXTRA_ENV" <<'EOF'
cd deploy/compose
mkdir -p secrets/gateway secrets/devcp
sed -E "s#^( *apiUrl:).*#\1 https://$PVE_LAN_IP:8006#" config/sbx.yaml >secrets/devcp/sbx.yaml
grep -q "apiUrl: https://$PVE_LAN_IP:8006" secrets/devcp/sbx.yaml
if [ ! -s secrets/data-keys.json ]; then
	(umask 077 && printf '{"current":1,"keys":{"1":"%s"}}\n' "$(head -c 32 /dev/urandom | base64)" >secrets/data-keys.json)
fi
cat >.env <<ENV
# Written by infra/dev-cp/deploy.sh; changes are overwritten on the next deploy.
COMPOSE_FILE=$FILES:../../infra/dev-cp/compose.dev-cp.yaml
# The PVE host over the LAN. The worker reads the API URL from secrets/devcp/sbx.yaml.
SBX_PVE_URL=https://$PVE_LAN_IP:8006
SBX_PVE_TLS_NAME=pve
SBX_NODE_SSH_HOST=$PVE_LAN_IP
SBX_PVE_SECRETS_DIR=$HOME/.config/sbx
SBX_DEVCP_DOMAIN=$DOMAIN
SBX_TUNNEL_URL=wss://tunnel.$DOMAIN/v1/connect
$EXTRA_ENV
ENV
docker compose config --quiet
docker compose up -d --build --remove-orphans 2>&1 | grep -vE '^ *#[0-9]+ ' | tail -30
for _ in $(seq 1 90); do
	w=$(docker compose ps --format '{{.Health}}' worker)
	g=$(docker compose ps --format '{{.Health}}' gateway)
	[ "$w" = healthy ] && [ "$g" = healthy ] && break
	sleep 2
done
docker compose ps -a --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
echo "worker /readyz: $(curl -sS http://127.0.0.1:9090/readyz)"
echo "gateway /readyz: $(curl -sS http://127.0.0.1:9190/readyz)"
[ "$w" = healthy ] && [ "$g" = healthy ]
EOF
((DRY)) && exit 0

# 4. From this Mac: the gateway answers TLS for the tunnel name on the CT address.
ca=$(mktemp)
ssh -o BatchMode=yes "$CT" "cat ~/$DIR/deploy/compose/secrets/gateway/ca.pem" >"$ca"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$ca" \
	--resolve "tunnel.$DOMAIN:443:$CT_IP" "https://tunnel.$DOMAIN/v1/connect" || true)
rm -f "$ca"
log "https://tunnel.$DOMAIN/v1/connect via $CT_IP: HTTP $code (TLS verified by the dev CA)"
[[ "$code" =~ ^[0-9]{3}$ && "$code" != 000 ]] || log "WARNING: the tunnel listener is not reachable from this Mac (outside the LAN?)"
log "deployed"
