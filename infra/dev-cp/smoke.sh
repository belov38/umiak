#!/usr/bin/env bash
# umiak dev control plane: agent tunnel smoke test through the gateway on CT 590.
# Runs on the operator's Mac after infra/dev-cp/deploy.sh. Dev only.
#
#   infra/dev-cp/smoke.sh [--keep]
#
# 1. Checks that the gateway and baked agent pin the same dev CA.
# 2. Registers a new machine (bootstrap secret hash) in the CT database, as the worker does.
# 3. Clones one VM (2 GB) from template 597 into the free VMID nearest to 589, with the
#    machine's smbios, on umiak0 with group umiak-egress.
# 4. From the VM: the gateway port on the CT is reachable; other CT ports, the host, the
#    router and other LAN guests are not.
# 5. Checks the baked agent and waits for its session in tunnel.tunnel_sessions. Nothing in
#    the VM is patched: the tunnel URL comes from the smbios family (umiakt1:<url>, S5 14),
#    the tunnel host resolves through public DNS, and the baked package pins the dev CA.
# 6. Calls System/Info through @umiak/agent-client in the worker container.
# The VM and the database rows are deleted at the end (unless --keep).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
HOST="${UMIAK_SETUP_SSH:-pve}"
CT="${UMIAK_DEVCP_SSH:-umiak@$CT_IP}"
PVE_LAN_IP="${UMIAK_PVE_LAN_IP:-192.168.68.116}"
LAN_GW="${UMIAK_CP_GW:-192.168.68.1}"
# A LAN guest that must stay unreachable from sandboxes (CT 104 by default).
LAN_PEER="${UMIAK_DEVCP_SMOKE_LAN_PEER:-192.168.68.117}"
NAME=umiak-devcp-smoke

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
	} | ssh -o BatchMode=yes "$HOST" 'python3 -c '"'"'"""Run the deployment'"'"'"'"'"'"'"'"'s stdin script without shell-embedded temporary-file cleanup."""
import os
import subprocess
import sys
import tempfile

with tempfile.NamedTemporaryFile(delete=False) as script:
    script.write(sys.stdin.buffer.read())
try:
    result = subprocess.run(["bash", script.name], stdin=subprocess.DEVNULL, check=False)
finally:
    os.unlink(script.name)
raise SystemExit(result.returncode)
'"'"''
}

# ctsql runs SQL on the CT database.
ctsql() {
	ssh -o BatchMode=yes "$CT" "cd umiak/deploy/compose && docker compose exec -T postgres psql -U umiak -d umiak -v ON_ERROR_STOP=1 -Atq" <<<"$1"
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
	qm config "$id" | grep -q '^tags:.*umiak-devcp-smoke' || continue
	qm stop "$id" >/dev/null 2>&1 || true
	qm destroy "$id" --purge 1
	echo "cleanup: VM $id destroyed"
done
EOF
		ctsql "DELETE FROM tunnel.tunnel_sessions WHERE machine_id = '$MID'; DELETE FROM tunnel.tunnel_credentials WHERE machine_id = '$MID';" || rc=1
	fi
	rm -rf "$work"
	exit "$rc"
}
trap cleanup EXIT

# 1. A sealed recipe already has a signed agent and trusted update keys. Never replace
# its root of trust with the throwaway keys of the historical S3 installer fixture.
[[ -s "$CA_DIR/ca.pem" ]] || die "no $CA_DIR/ca.pem (infra/dev-cp/deploy.sh)"
[[ "$(ssh -o BatchMode=yes "$CT" 'cat umiak/deploy/compose/secrets/gateway/ca.pem')" == "$(cat "$CA_DIR/ca.pem")" ]] ||
	die "the gateway on the CT does not use $CA_DIR/ca.pem (run infra/dev-cp/deploy.sh)"
ca_sha=$(shasum -a 256 "$CA_DIR/ca.pem" | cut -d' ' -f1)

# 2. Machine identity: the bootstrap secret stays in this process and in the VM's smbios;
# the database gets only its SHA-256 (S2 §5.2).
head -c 32 /dev/urandom >"$work/bs"
bs64=$(base64 <"$work/bs" | tr '+/' '-_' | tr -d '=\n')
serial=$(printf 'umiak1:%s:%s' "$MID" "$bs64" | base64 | tr -d '\n')
family=$(printf 'umiakt1:%s' "$TUNNEL_URL" | base64 | tr -d '\n')
hash=$(shasum -a 256 "$work/bs" | cut -d' ' -f1)
rm -f "$work/bs"
ctsql "INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash) VALUES ('$MID', '\\x$hash');"
log "machine $MID registered"

# 3-5. The VM, network probes, the agent.
remote "CA_SHA=$ca_sha" "NAME=$NAME" "MID=$MID" "SERIAL=$serial" "FAMILY=$family" "CT_IP=$CT_IP" "TUNNEL_HOST=$TUNNEL_HOST" \
	"TUNNEL_URL=$TUNNEL_URL" "PVE_LAN_IP=$PVE_LAN_IP" "LAN_GW=$LAN_GW" "LAN_PEER=$LAN_PEER" <<'EOF'
avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
[ "$avail" -ge $((2048 + 4096)) ] || { echo "smoke: only $avail MB available on the host" >&2; exit 1; }
# One VM in 500-589; CT 590 and fixed recipe slots 595-598 stay outside the allocation range.
id=""
for c in $(seq 589 -1 500); do
	qm config "$c" >/dev/null 2>&1 && continue
	pct config "$c" >/dev/null 2>&1 && continue
	if qm clone 597 "$c" --name "$NAME" --pool umiak >/dev/null 2>&1; then id=$c; break; fi
done
[ -n "$id" ] || { echo "smoke: no free VMID in 500-589" >&2; exit 1; }
qm set "$id" --tags umiak-devcp-smoke --memory 2048 --cores 2 --smbios1 "uuid=$MID,serial=$SERIAL,family=$FAMILY,base64=1" >/dev/null
# Sealed recipes deliberately clear their build firewall. Configure only this disposable clone;
# ipfilter permits DHCP but keeps data traffic closed until its assigned IPv4 is installed below.
pvesh create "/nodes/pve/qemu/$id/firewall/rules" --type group --action umiak-egress --iface net0 --enable 1 >/dev/null
pvesh set "/nodes/pve/qemu/$id/firewall/options" --enable 1 --policy_in DROP --policy_out ACCEPT --dhcp 1 --ndp 1 --macfilter 1 --ipfilter 1 >/dev/null
grep -q 'GROUP umiak-egress -i net0' "/etc/pve/firewall/$id.fw" || { echo "smoke: VM $id has no umiak-egress rule" >&2; exit 1; }
qm config "$id" | grep -q 'bridge=umiak0,firewall=1' || { echo "smoke: VM $id is not on umiak0 with firewall" >&2; exit 1; }
echo "smoke: VM $id cloned from 597 (umiak0, firewall group umiak-egress)"
used=$(qm list | awk 'NR>1 && $1>=500 && $1<=599 && $3=="running" {n+=$4} END {print n+0}')
[ "$((used + 2048))" -le 8192 ] || { echo "smoke: sandbox RAM budget exceeded" >&2; exit 1; }
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
for _ in $(seq 1 60); do g 10 sh -c 'ip -4 -o addr show scope global | grep -q inet' >/dev/null 2>&1 && break; sleep 2; done
echo "smoke: guest $(g 10 sh -c '. /etc/os-release; echo $PRETTY_NAME') $(g 10 sh -c 'ip -4 -o addr show scope global' | awk '{print $4}')"
ip=$(g 10 ip -4 -j addr show scope global | python3 -c 'import json,sys; print(next(a["local"] for link in json.load(sys.stdin) for a in link.get("addr_info", []) if a.get("family")=="inet" and a["local"].startswith("10.88.0.")))')
python3 - "$id" "$ip" <<'PYIP'
import ipaddress, json, subprocess, sys
from urllib.parse import quote
vmid, address = int(sys.argv[1]), ipaddress.ip_address(sys.argv[2])
assert 500 <= vmid <= 589 and address in ipaddress.ip_network("10.88.0.0/24")
base = f"/nodes/pve/qemu/{vmid}/firewall/ipset"
result = subprocess.run(["pvesh", "get", base + "/ipfilter-net0", "--output-format", "json"], capture_output=True, text=True)
if result.returncode:
    subprocess.run(["pvesh", "create", base, "--name", "ipfilter-net0"], check=True, stdout=subprocess.DEVNULL)
else:
    for entry in json.loads(result.stdout):
        subprocess.run(["pvesh", "delete", base + "/ipfilter-net0/" + quote(entry["cidr"], safe="")], check=True, stdout=subprocess.DEVNULL)
subprocess.run(["pvesh", "create", base + "/ipfilter-net0", "--cidr", str(address)], check=True, stdout=subprocess.DEVNULL)
PYIP
# Wait for pve-firewall's regular compile/apply cycle, without restarting it.
sleep 5

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

# Verify the baked agent's pinned CA without installing a diagnostic package or changing trust.
pinned=$(g 10 sha256sum /usr/local/lib/umiak-agent/current/trust/tunnel-ca.pem | awk '{print $1}')
[ "$pinned" = "$CA_SHA" ] || { echo "smoke: baked agent does not pin the dev CA" >&2; exit 1; }
echo "smoke: baked agent CA matches the gateway"
g 10 systemctl is-active umiak-identity umiak-agent
doctor=$(g 30 /usr/local/bin/umiak-agent doctor --json)
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
t = d["tunnel_url"]
print("smoke: agent", d["versions"]["current"], "tunnel", t["url"], "source", t["source"])
if t["url"] != sys.argv[2] or t["source"] != "smbios":
    sys.exit("smoke: the agent does not use the tunnel URL from the smbios family")' "$doctor" "$TUNNEL_URL"
g 10 sh -c 'grep -E "^ *(url|trust_dir) *=" /etc/umiak-agent/agent.toml' | sed 's/^/smoke: agent.toml /'
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
import { AgentClient, PgRegistry } from "@umiak/agent-client";
import { System } from "@umiak/proto/agent/v1";
const registry = await PgRegistry.connect({ connectionString: process.env.DATABASE_URL, maxConnections: 2 });
const client = new AgentClient({ registry, serviceToken: readFileSync(process.env.UMIAK_GATEWAY_SERVICE_TOKEN_FILE, "utf8").trim() });
try {
	const r = await createClient(System, client.transport(process.argv[1])).info({}, { timeoutMs: 30000 });
	console.log(JSON.stringify({ machineId: r.machineId, version: r.version, os: r.os, arch: r.arch, kernel: r.kernel, hostname: r.hostname, tunnelUrl: r.tunnelUrl, tunnelUrlSource: r.tunnelUrlSource }));
} finally {
	await client.close();
	await registry.close();
}'
info=$(ssh -o BatchMode=yes "$CT" "cd umiak/deploy/compose && docker compose exec -T -w /app/apps/worker worker node --input-type=module -e $(printf '%q' "$info_js") $MID")
log "System/Info: $info"
[[ "$info" == *"\"machineId\":\"$MID\""* ]] || die "System/Info returned another machine"
log "smoke: ok"
