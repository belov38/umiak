#!/usr/bin/env bash
# boat-dev-clone dev control plane: agent tunnel smoke test through the gateway on CT 590.
# Runs on the operator's Mac after infra/dev-cp/deploy.sh. Dev only.
#
#   infra/dev-cp/smoke.sh [--keep]
#
# 1. Builds the dev-signed agent package (services/guest-agent/test/linux/run.sh BUILD_ONLY).
# 2. Registers a new machine (bootstrap secret hash) in the CT database, as the worker does.
# 3. Clones one VM (2 GB) from template 599 into the free VMID nearest to 589, with the
#    machine's smbios, on sbx0 with group sbx-egress.
# 4. From the VM: the gateway port on the CT is reachable; other CT ports, the host, the
#    router and other LAN guests are not.
# 5. Installs the agent as the S3 stand does (stand-setup.sh install) and waits for the session
#    in tunnel.tunnel_sessions. Nothing in the VM is patched: the tunnel URL comes from the
#    smbios family (sbxt1:<url>, S5 14) as the worker will set it, the tunnel host resolves
#    through the VM's public DNS (sslip.io), and the package pins the dev CA as its tunnel CA.
# 6. Calls System/Info through @sbx/agent-client in the worker container.
# The VM and the database rows are deleted at the end (unless --keep).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
HOST="${SBX_SETUP_SSH:-pve}"
CT="${SBX_DEVCP_SSH:-sbx@$CT_IP}"
PVE_LAN_IP="${SBX_PVE_LAN_IP:-192.168.68.116}"
LAN_GW="${SBX_CP_GW:-192.168.68.1}"
# A LAN guest that must stay unreachable from sandboxes (CT 104 by default).
LAN_PEER="${SBX_DEVCP_SMOKE_LAN_PEER:-192.168.68.117}"
NAME=sbx-devcp-smoke
REPO="$(cd "$HERE/../.." && pwd)"

KEEP=0
if [[ "${1:-}" == "--keep" ]]; then
	KEEP=1
	shift
fi
[[ $# -eq 0 ]] || {
	sed -n '2,5p' "$0"
	exit 2
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

# remote runs a bash script from stdin on the PVE host (root), with exported KEY=value prefixes.
remote() {
	local prefix=""
	local kv
	for kv in "$@"; do
		prefix+="export ${kv%%=*}=$(printf '%q' "${kv#*=}")"$'\n'
	done
	{
		printf '%sset -euo pipefail\n' "$prefix"
		cat
	} | ssh -o BatchMode=yes "$HOST" 'f=$(mktemp); cat >"$f"; bash "$f" </dev/null; rc=$?; rm -f "$f"; exit $rc'
}

# ctsql runs SQL on the CT database.
ctsql() {
	ssh -o BatchMode=yes "$CT" "cd boat-dev-clone/deploy/compose && docker compose exec -T postgres psql -U sbx -d sbx -v ON_ERROR_STOP=1 -Atq" <<<"$1"
}

work=$(mktemp -d)
MID=$(uuidgen | tr '[:upper:]' '[:lower:]')
cleanup() {
	local rc=$?
	if ((KEEP)); then
		log "--keep: VM $NAME and machine $MID stay"
	else
		log "cleanup: VM $NAME, machine $MID"
		remote "NAME=$NAME" <<'EOF' || rc=1
for id in $(qm list | awk -v n="$NAME" '$2 == n {print $1}'); do
	[ "$id" -ge 500 ] && [ "$id" -le 589 ] || continue
	qm config "$id" | grep -q '^tags:.*sbx-devcp-smoke' || continue
	qm stop "$id" >/dev/null 2>&1 || true
	qm destroy "$id" --purge 1
	echo "cleanup: VM $id destroyed"
done
rm -rf /tmp/sbx-devcp-smoke
EOF
		ctsql "DELETE FROM tunnel.tunnel_sessions WHERE machine_id = '$MID'; DELETE FROM tunnel.tunnel_credentials WHERE machine_id = '$MID';" || rc=1
	fi
	rm -rf "$work"
	exit "$rc"
}
trap cleanup EXIT

# 1. The agent package, signed with a throwaway dev key, with the dev CA as its tunnel CA (the
# gateway on the CT uses the same CA: deploy.sh), and stand-setup.sh.
[[ -s "$CA_DIR/ca.pem" ]] || die "no $CA_DIR/ca.pem (infra/dev-cp/deploy.sh)"
[[ "$(ssh -o BatchMode=yes "$CT" 'cat boat-dev-clone/deploy/compose/secrets/gateway/ca.pem')" == "$(cat "$CA_DIR/ca.pem")" ]] ||
	die "the gateway on the CT does not use $CA_DIR/ca.pem (run infra/dev-cp/deploy.sh)"
log "build the agent package (linux/amd64, tunnel CA $CA_DIR/ca.pem)"
BUILD_ONLY="$work" GOARCH_IT=amd64 TUNNEL_CA="$CA_DIR/ca.pem" "$REPO/services/guest-agent/test/linux/run.sh" >/dev/null
[[ -s "$work/it/pkg/v1.tar" ]] || die "no $work/it/pkg/v1.tar"
[[ "$(tar -xOf "$work/it/pkg/v1.tar" trust/tunnel-ca.pem)" == "$(cat "$CA_DIR/ca.pem")" ]] || die "the package does not pin the dev CA"
ssh -o BatchMode=yes "$HOST" 'rm -rf /tmp/sbx-devcp-smoke && mkdir -m 700 /tmp/sbx-devcp-smoke'
scp -q "$work/it/pkg/v1.tar" "$REPO/services/guest-agent/test/linux/stand-setup.sh" "$HOST:/tmp/sbx-devcp-smoke/"
log "package $(($(wc -c <"$work/it/pkg/v1.tar") / 1024)) KiB"

# 2. Machine identity: the bootstrap secret stays in this process and in the VM's smbios;
# the database gets only its SHA-256 (S2 §5.2).
head -c 32 /dev/urandom >"$work/bs"
bs64=$(base64 <"$work/bs" | tr '+/' '-_' | tr -d '=\n')
serial=$(printf 'sbx1:%s:%s' "$MID" "$bs64" | base64 | tr -d '\n')
family=$(printf 'sbxt1:%s' "$TUNNEL_URL" | base64 | tr -d '\n')
hash=$(shasum -a 256 "$work/bs" | cut -d' ' -f1)
rm -f "$work/bs"
ctsql "INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash) VALUES ('$MID', '\\x$hash');"
log "machine $MID registered"

# 3-5. The VM, network probes, the agent.
remote "NAME=$NAME" "MID=$MID" "SERIAL=$serial" "FAMILY=$family" "CT_IP=$CT_IP" "TUNNEL_HOST=$TUNNEL_HOST" \
	"TUNNEL_URL=$TUNNEL_URL" "PVE_LAN_IP=$PVE_LAN_IP" "LAN_GW=$LAN_GW" "LAN_PEER=$LAN_PEER" <<'EOF'
d=/tmp/sbx-devcp-smoke
avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
[ "$avail" -ge $((2048 + 4096)) ] || { echo "smoke: only $avail MB available on the host" >&2; exit 1; }
# One VM, the free sandbox VMID nearest to 589 (500-589; 590-596 dev, 597-599 templates); qm clone fails if another thread took it meanwhile.
id=""
for c in $(seq 589 -1 500); do
	qm config "$c" >/dev/null 2>&1 && continue
	pct config "$c" >/dev/null 2>&1 && continue
	if qm clone 599 "$c" --name "$NAME" --pool sandbox >/dev/null 2>&1; then id=$c; break; fi
done
[ -n "$id" ] || { echo "smoke: no free VMID in 500-589" >&2; exit 1; }
qm set "$id" --tags sbx-devcp-smoke --memory 2048 --cores 2 --smbios1 "uuid=$MID,serial=$SERIAL,family=$FAMILY,base64=1" >/dev/null
grep -q 'GROUP sbx-egress -i net0' "/etc/pve/firewall/$id.fw" || { echo "smoke: VM $id has no sbx-egress rule" >&2; exit 1; }
qm config "$id" | grep -q 'bridge=sbx0,firewall=1' || { echo "smoke: VM $id is not on sbx0 with firewall" >&2; exit 1; }
echo "smoke: VM $id cloned from 599 (sbx0, firewall group sbx-egress)"
qm start "$id"
for _ in $(seq 1 120); do qm guest cmd "$id" ping >/dev/null 2>&1 && break; sleep 2; done
qm guest cmd "$id" ping >/dev/null

# g runs a command in the guest: out-data to stdout, err-data to stderr, its exit code.
g() {
	local t=$1
	shift
	qm guest exec "$id" --timeout "$t" -- "$@" | python3 -c '
import json, sys
d = json.load(sys.stdin)
sys.stdout.write(d.get("out-data", ""))
sys.stderr.write(d.get("err-data", ""))
sys.exit(d.get("exitcode", 1) if d.get("exited") else 124)'
}
# push copies a host file into the guest through QGA stdin, in base64 chunks.
push() {
	local src=$1 dst=$2 c
	g 30 sh -c "mkdir -p $(dirname "$dst") && : >$dst.b64"
	rm -rf "$d/chunks" && mkdir "$d/chunks"
	base64 -w0 "$src" | split -b 500000 - "$d/chunks/c"
	for c in "$d"/chunks/c*; do
		qm guest exec "$id" --timeout 60 --pass-stdin 1 -- sh -c "cat >>$dst.b64" <"$c" >/dev/null
	done
	g 60 sh -c "base64 -d $dst.b64 >$dst && rm -f $dst.b64"
	[ "$(g 30 sha256sum "$dst" | cut -d' ' -f1)" = "$(sha256sum "$src" | cut -d' ' -f1)" ] || { echo "smoke: push $dst: checksum mismatch" >&2; exit 1; }
}
for _ in $(seq 1 60); do g 10 sh -c 'ip -4 -o addr show scope global | grep -q inet' >/dev/null 2>&1 && break; sleep 2; done
echo "smoke: guest $(g 10 sh -c '. /etc/os-release; echo $PRETTY_NAME') $(g 10 sh -c 'ip -4 -o addr show scope global' | awk '{print $4}')"

# Network from the sandbox: only the gateway port on the CT, plus the internet.
probe() { g 10 timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1 && echo open || echo closed; }
ping1() { g 10 ping -c 1 -W 3 "$1" >/dev/null 2>&1 && echo open || echo closed; }
fail=0
expect() {
	local want=$1 what=$2 got=$3
	if [ "$got" = "$want" ]; then echo "smoke: net ok   $what $got"; else echo "smoke: net FAIL $what $got (want $want)"; fail=1; fi
}
expect open "ct $CT_IP:443 (gateway)" "$(probe "$CT_IP" 443)"
for p in 22 2222 5432 7000 9090 9190 8080; do expect closed "ct $CT_IP:$p" "$(probe "$CT_IP" "$p")"; done
expect closed "ct $CT_IP icmp" "$(ping1 "$CT_IP")"
for p in 22 8006; do
	expect closed "host $PVE_LAN_IP:$p" "$(probe "$PVE_LAN_IP" "$p")"
	expect closed "host 10.88.0.1:$p" "$(probe 10.88.0.1 "$p")"
done
for p in 53 80 443; do expect closed "router $LAN_GW:$p" "$(probe "$LAN_GW" "$p")"; done
expect closed "router $LAN_GW icmp" "$(ping1 "$LAN_GW")"
expect closed "lan guest $LAN_PEER:22" "$(probe "$LAN_PEER" 22)"
expect closed "lan guest $LAN_PEER icmp" "$(ping1 "$LAN_PEER")"
expect open "internet 1.1.1.1:443" "$(probe 1.1.1.1 443)"
[ "$fail" = 0 ] || { echo "smoke: network isolation checks failed" >&2; exit 1; }

# The tunnel host through the VM's own resolver (public DNS from DHCP), not /etc/hosts.
g 10 grep -q "$TUNNEL_HOST" /etc/hosts && { echo "smoke: $TUNNEL_HOST is in /etc/hosts of the VM" >&2; exit 1; }
resolved=$(g 15 getent ahostsv4 "$TUNNEL_HOST" | awk 'NR == 1 {print $1}')
echo "smoke: dns $TUNNEL_HOST -> ${resolved:-nothing} ($(g 10 sh -c 'resolvectl dns 2>/dev/null || grep ^nameserver /etc/resolv.conf' | tr -s '\n' ' '))"
[ "$resolved" = "$CT_IP" ] || { echo "smoke: $TUNNEL_HOST does not resolve to $CT_IP in the VM" >&2; exit 1; }

# The agent as the S3 stand installs it. Its agent.toml points the tunnel nowhere; the smbios
# family wins, and the tunnel CA is the one in the package.
push "$d/v1.tar" /it/pkg/v1.tar
push "$d/stand-setup.sh" /it/stand-setup.sh
g 300 bash /it/stand-setup.sh install 2>&1 | tail -3
sleep 3
doctor=$(g 30 /usr/local/bin/sbx-agent doctor --json)
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
t = d["tunnel_url"]
print("smoke: agent", d["versions"]["current"], "tunnel", t["url"], "source", t["source"])
if t["url"] != sys.argv[2] or t["source"] != "smbios":
    sys.exit("smoke: the agent does not use the tunnel URL from the smbios family")' "$doctor" "$TUNNEL_URL"
g 10 sh -c 'grep -E "^ *(url|trust_dir) *=" /etc/sbx-agent/agent.toml' | sed 's/^/smoke: agent.toml /'
echo "VMID=$id"
EOF

# 5. The session in the registry.
log "waiting for the tunnel session"
state=""
for _ in $(seq 1 30); do
	state=$(ctsql "SELECT state || ' ' || agent_version || ' ' || instance_id FROM tunnel.tunnel_sessions WHERE machine_id = '$MID';")
	[[ "$state" == connected* ]] && break
	sleep 2
done
[[ "$state" == connected* ]] || die "no connected session for $MID (got '$state')"
log "tunnel.tunnel_sessions: $MID $state"

# 6. System/Info through the gateway with the worker's service token (as ConnectAgentPort calls it).
# shellcheck disable=SC2016 # JavaScript, not shell
info_js='
import { readFileSync } from "node:fs";
import { createClient } from "@connectrpc/connect";
import { AgentClient, PgRegistry } from "@sbx/agent-client";
import { System } from "@sbx/proto/agent/v1";
const registry = await PgRegistry.connect({ connectionString: process.env.DATABASE_URL, maxConnections: 2 });
const client = new AgentClient({ registry, serviceToken: readFileSync(process.env.SBX_GATEWAY_SERVICE_TOKEN_FILE, "utf8").trim() });
try {
	const r = await createClient(System, client.transport(process.argv[1])).info({}, { timeoutMs: 30000 });
	console.log(JSON.stringify({ machineId: r.machineId, version: r.version, os: r.os, arch: r.arch, kernel: r.kernel, hostname: r.hostname, tunnelUrl: r.tunnelUrl, tunnelUrlSource: r.tunnelUrlSource }));
} finally {
	await client.close();
	await registry.close();
}'
info=$(ssh -o BatchMode=yes "$CT" "cd boat-dev-clone/deploy/compose && docker compose exec -T -w /app/apps/worker worker node --input-type=module -e $(printf '%q' "$info_js") $MID")
log "System/Info: $info"
[[ "$info" == *"\"machineId\":\"$MID\""* ]] || die "System/Info returned another machine"
log "smoke: ok"
