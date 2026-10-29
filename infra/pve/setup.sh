#!/usr/bin/env bash
# boat-dev-clone S1 PoC: prepare the Proxmox host for sandboxes.
# Runs on the operator's Mac and executes each step on the host over SSH (root).
# Spec: docs/specs/s1-proxmox-foundation.md section 4.
#
#   infra/pve/setup.sh [--dry-run] <user|net|sdn|node|fw|template|status>
#   infra/pve/setup.sh [--dry-run] revert <user|net|sdn|node|fw|template>
#
# Every step is idempotent: it checks whether it is already done, applies, then verifies.
set -euo pipefail

HOST="${SBX_SETUP_SSH:-pve}"
HOST_LAN="${SBX_SETUP_SSH_LAN:-pve-lan}"
TS_NAME="${SBX_PVE_TS_NAME:-pve.tail0000.ts.net}"
TS_IP="${SBX_PVE_TS_IP:-100.64.10.2}"
LAN_IP="${SBX_PVE_LAN_IP:-192.168.68.116}"
NODE="${SBX_PVE_NODE:-pve}"
CFG_DIR="${SBX_CONFIG_DIR:-$HOME/.config/sbx}"
DENY_PUBLIC_IPS="${SBX_DENY_PUBLIC_IPS:-}"
# Tailscale addresses of existing guests. The operator Mac is not on the host LAN, so pinging these
# is how the fw step checks that bridged traffic of existing guests still flows through vmbr0.
TS_PEERS="${SBX_FW_TS_PEERS:-100.64.10.11 100.64.10.12 100.64.10.13 100.64.10.14 100.64.10.15 100.64.10.16 100.64.10.17}"
COMMENT="boat-dev-clone S1 PoC"
TEMPLATE_VMID=599
TEMPLATE_MAC="02:01:00:00:02:57"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY=1
	shift
fi

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

# remote runs a bash script from stdin on the host. Variables are passed as exported prefix lines.
remote() {
	local prefix=""
	local kv
	for kv in "$@"; do
		prefix+="export ${kv%%=*}=$(printf '%q' "${kv#*=}")"$'\n'
	done
	if ((DRY)); then
		printf -- '--- remote script on %s ---\n%sset -euo pipefail\n' "$HOST" "$prefix"
		cat
		printf -- '--- end ---\n'
		return 0
	fi
	{
		printf '%sset -euo pipefail\n' "$prefix"
		cat
	} | ssh -o BatchMode=yes "$HOST" 'f=$(mktemp); cat >"$f"; bash "$f" </dev/null; rc=$?; rm -f "$f"; exit $rc'
}

# local_run prints or runs a local command.
local_run() {
	if ((DRY)); then
		printf -- '+ %s\n' "$*"
		return 0
	fi
	"$@"
}

PRIVS="VM.Allocate,VM.Audit,VM.Clone,VM.Config.CDROM,VM.Config.CPU,VM.Config.Cloudinit,VM.Config.Disk,VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.PowerMgmt,VM.GuestAgent.Audit,VM.GuestAgent.FileRead,VM.GuestAgent.FileWrite,VM.GuestAgent.FileSystemMgmt,VM.GuestAgent.Unrestricted,Pool.Audit"

# ---------------------------------------------------------------- 4.1 user, token, pool

step_user() {
	log "user: role SbxPoC, pool sandbox, user sbx@pve, ACLs"
	remote "PRIVS=$PRIVS" "COMMENT=$COMMENT" <<'EOF'
if pveum role list --output-format json | grep -q '"roleid":"SbxPoC"'; then
	pveum role modify SbxPoC --privs "$PRIVS"
else
	pveum role add SbxPoC --privs "$PRIVS"
fi
pvesh get /pools/sandbox >/dev/null 2>&1 || pveum pool add sandbox --comment "$COMMENT"
pveum user list --output-format json | grep -q '"userid":"sbx@pve"' || pveum user add sbx@pve --comment "$COMMENT"
pveum acl modify /pool/sandbox --users sbx@pve --roles SbxPoC
pveum acl modify /storage/local-lvm --users sbx@pve --roles PVEDatastoreUser
EOF
	# Token: the secret is shown only once, so it goes straight into a 600 file and never to the terminal.
	local secret_file="$CFG_DIR/pve-token"
	local have_token
	have_token=$(remote <<'EOF'
pveum user token list sbx@pve --output-format json | grep -q '"tokenid":"poc"' && echo yes || echo no
EOF
)
	if ((DRY)) || [[ "$have_token" != "yes" || ! -s "$secret_file" ]]; then
		log "user: (re)creating token sbx@pve!poc"
		local_run mkdir -p "$CFG_DIR"
		local_run chmod 700 "$CFG_DIR"
		if ((DRY)); then
			printf -- '+ ssh %s pveum user token add sbx@pve poc --privsep 1 ... > %s\n' "$HOST" "$secret_file"
		else
			(
				umask 077
				ssh -o BatchMode=yes "$HOST" "pveum user token remove sbx@pve poc >/dev/null 2>&1 || true; pveum user token add sbx@pve poc --privsep 1 --comment '$COMMENT' --output-format json" |
					python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["value"])' >"$secret_file"
			)
			chmod 600 "$secret_file"
		fi
	fi
	remote <<'EOF'
pveum acl modify /pool/sandbox --tokens 'sbx@pve!poc' --roles SbxPoC
pveum acl modify /storage/local-lvm --tokens 'sbx@pve!poc' --roles PVEDatastoreUser
EOF
	if ((DRY)); then
		printf -- '+ scp %s:/etc/pve/pve-root-ca.pem %s/pve-root-ca.pem\n' "$HOST" "$CFG_DIR"
	else
		scp -q "$HOST:/etc/pve/pve-root-ca.pem" "$CFG_DIR/pve-root-ca.pem"
		verify_token
	fi
}

verify_token() {
	local code
	code=$(curl -sS -o /dev/null -w '%{http_code}' --cacert "$CFG_DIR/pve-root-ca.pem" \
		--resolve "pve:8006:$TS_IP" \
		-H "Authorization: PVEAPIToken=sbx@pve!poc=$(cat "$CFG_DIR/pve-token")" \
		https://pve:8006/api2/json/pools/sandbox)
	[[ "$code" == "200" ]] || die "token check: GET /pools/sandbox returned $code"
	log "user: token works (GET /pools/sandbox 200, TLS verified by host CA as 'pve')"
}

revert_user() {
	remote <<'EOF'
pveum user delete sbx@pve || true
pveum role delete SbxPoC || true
pveum pool delete sandbox || true
EOF
	local_run rm -f "$CFG_DIR/pve-token"
}

# ---------------------------------------------------------------- 4.2 dnsmasq, IPv4 forwarding

step_net() {
	log "net: dnsmasq package (system service disabled), net.ipv4.ip_forward=1"
	remote "COMMENT=$COMMENT" <<'EOF'
if ! dpkg -s dnsmasq >/dev/null 2>&1; then
	# Mask first so the package does not start a system-wide DNS server on install.
	systemctl mask dnsmasq.service
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q dnsmasq dnsmasq-utils
	systemctl unmask dnsmasq.service
fi
dpkg -s dnsmasq-utils >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -q dnsmasq-utils
systemctl disable --now dnsmasq.service
cat >/etc/sysctl.d/90-sbx-poc.conf <<CONF
# $COMMENT: IPv4 forwarding for SNAT of SDN zone "sbx". Remove this file to revert.
net.ipv4.ip_forward = 1
CONF
# Apply only this file: sysctl --system could re-apply unrelated drifted values.
sysctl -p /etc/sysctl.d/90-sbx-poc.conf
[ "$(sysctl -n net.ipv4.ip_forward)" = 1 ]
[ "$(sysctl -n net.ipv6.conf.all.forwarding)" = 0 ]
! systemctl is-active --quiet dnsmasq.service
echo "net: ok"
EOF
}

revert_net() {
	remote <<'EOF'
rm -f /etc/sysctl.d/90-sbx-poc.conf
sysctl -w net.ipv4.ip_forward=0
DEBIAN_FRONTEND=noninteractive apt-get purge -y -q dnsmasq dnsmasq-utils
EOF
}

# ---------------------------------------------------------------- 4.3 SDN

step_sdn() {
	log "sdn: zone sbx, vnet sbx0 (isolate-ports), subnet 10.88.0.0/24 with SNAT and DHCP"
	remote <<'EOF'
# Snapshot of vmbr0 without counters and timers that change on their own.
snap_vmbr0() { ip -d -o link show vmbr0 | sed -E 's/ qlen [0-9]+//; s/[a-z_]*timer +[0-9.]+(us)?//g; s/fdb_n_learned [0-9]+//'; ip -o addr show vmbr0; ip route show default; }
# ifreload during SDN apply resets mcast_hash_max of vmbr0 to the ifupdown2 default; keep the live value.
hash_max=$(ip -d link show vmbr0 | grep -o 'mcast_hash_max [0-9]*' | cut -d' ' -f2)
if ifquery --check -a 2>&1 | grep -q '\[fail\]'; then
	echo "sdn: /etc/network/interfaces differs from the running state, refusing to apply" >&2
	ifquery --check -a 2>&1 | grep '\[fail\]' >&2
	exit 1
fi
before=$(snap_vmbr0)
changed=0
if ! pvesh get /cluster/sdn/zones/sbx >/dev/null 2>&1; then
	pvesh create /cluster/sdn/zones --zone sbx --type simple --ipam pve --dhcp dnsmasq
	changed=1
fi
if ! pvesh get /cluster/sdn/vnets/sbx0 >/dev/null 2>&1; then
	pvesh create /cluster/sdn/vnets --vnet sbx0 --zone sbx --isolate-ports 1 --alias boat-dev-clone-S1-PoC
	changed=1
fi
if ! pvesh get /cluster/sdn/vnets/sbx0/subnets --output-format json | grep -q '10.88.0.0/24'; then
	pvesh create /cluster/sdn/vnets/sbx0/subnets --subnet 10.88.0.0/24 --type subnet \
		--gateway 10.88.0.1 --snat 1 \
		--dhcp-range start-address=10.88.0.100,end-address=10.88.0.250 \
		--dhcp-dns-server 1.1.1.1
	changed=1
fi
if [ "$changed" = 1 ] || ! ip link show sbx0 >/dev/null 2>&1; then
	pvesh set /cluster/sdn
	for _ in $(seq 1 60); do
		ip link show sbx0 >/dev/null 2>&1 && systemctl is-active --quiet dnsmasq@sbx && break
		sleep 1
	done
fi
cur=$(ip -d link show vmbr0 | grep -o 'mcast_hash_max [0-9]*' | cut -d' ' -f2)
if [ "$cur" != "$hash_max" ]; then
	echo "sdn: restoring vmbr0 mcast_hash_max $cur -> $hash_max"
	ip link set dev vmbr0 type bridge mcast_hash_max "$hash_max"
fi
pveum acl modify /sdn/zones/sbx --users sbx@pve --roles PVESDNUser
pveum acl modify /sdn/zones/sbx --tokens 'sbx@pve!poc' --roles PVESDNUser
ip -br addr show sbx0
iptables -t nat -S POSTROUTING | grep -q -- '-s 10.88.0.0/24' || { echo "sdn: SNAT rule missing" >&2; exit 1; }
systemctl is-active --quiet dnsmasq@sbx || { echo "sdn: dnsmasq@sbx not running" >&2; exit 1; }
after=$(snap_vmbr0)
[ "$before" = "$after" ] || { echo "sdn: vmbr0 changed!" >&2; diff <(echo "$before") <(echo "$after") >&2; exit 1; }
echo "sdn: ok (vmbr0 unchanged)"
EOF
}

revert_sdn() {
	remote <<'EOF'
pvesh delete /cluster/sdn/vnets/sbx0/subnets/sbx-10.88.0.0-24 || true
pvesh delete /cluster/sdn/vnets/sbx0 || true
pvesh delete /cluster/sdn/zones/sbx || true
hash_max=$(ip -d link show vmbr0 | grep -o 'mcast_hash_max [0-9]*' | cut -d' ' -f2)
pvesh set /cluster/sdn
sleep 10
ip link set dev vmbr0 type bridge mcast_hash_max "$hash_max"
EOF
}

# ---------------------------------------------------------------- 4.5 sbx-node and its SSH key

step_node() {
	log "node: build sbx-node, install binary and config, restricted SSH key, pinned host key"
	local key="$CFG_DIR/sbx-node_ed25519"
	local bin="$REPO/bin/sbx-node"
	local_run mkdir -p "$CFG_DIR"
	if [[ ! -f "$key" ]]; then
		local_run ssh-keygen -q -t ed25519 -N '' -C 'boat-dev-clone S1 sbx-node' -f "$key"
	fi
	(cd "$REPO/services/node-agent" && local_run env GOOS=linux GOARCH=amd64 CGO_ENABLED=0 mise exec -- go build \
		-ldflags "-X main.version=$(git -C "$REPO" rev-parse --short HEAD)" -o "$bin" ./cmd/sbx-node)
	local_run scp -q "$bin" "$HOST:/usr/local/bin/sbx-node.new"
	local_run scp -q "$HERE/sbx-node.toml" "$HOST:/etc/sbx-node.toml.new"
	local pub=""
	if [[ -f "$key.pub" ]]; then
		pub=$(cat "$key.pub")
	fi
	remote "PUB=$pub" <<'EOF'
install -m 0755 /usr/local/bin/sbx-node.new /usr/local/bin/sbx-node && rm -f /usr/local/bin/sbx-node.new
install -m 0644 /etc/sbx-node.toml.new /etc/sbx-node.toml && rm -f /etc/sbx-node.toml.new
line="restrict,command=\"/usr/local/bin/sbx-node --stdio\" $PUB"
ak=/etc/pve/priv/authorized_keys
if ! grep -qF "boat-dev-clone S1 sbx-node" "$ak"; then
	printf '%s\n' "$line" >>"$ak"
fi
grep -qF "$line" "$ak" || { echo "node: authorized_keys has a different sbx-node line" >&2; exit 1; }
EOF
	if ((DRY)); then
		printf -- '+ write %s/known_hosts from %s:/etc/ssh/ssh_host_ed25519_key.pub\n' "$CFG_DIR" "$HOST"
		return 0
	fi
	# Pin the host key over the already trusted root channel, not via keyscan.
	printf '%s %s\n' "$TS_NAME" "$(ssh -o BatchMode=yes "$HOST" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)" >"$CFG_DIR/known_hosts"
	verify_node
}

node_ssh() {
	ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -i "$CFG_DIR/sbx-node_ed25519" \
		-o UserKnownHostsFile="$CFG_DIR/known_hosts" -o StrictHostKeyChecking=yes "root@$TS_NAME" sbx-node
}

verify_node() {
	local out
	out=$(echo '{"op":"version","requestId":"setup"}' | node_ssh)
	[[ "$out" == *'"ok":true'* ]] || die "node: sbx-node version failed: $out"
	# The forced command must win over the requested command, and no pty is allowed.
	out=$(echo '{"op":"version","requestId":"setup-2"}' | ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes \
		-i "$CFG_DIR/sbx-node_ed25519" -o UserKnownHostsFile="$CFG_DIR/known_hosts" "root@$TS_NAME" "id" 2>/dev/null || true)
	[[ "$out" == *'"ok":true'* ]] || die "node: forced command not enforced: $out"
	log "node: sbx-node answers over the restricted key"
}

revert_node() {
	remote <<'EOF'
ak=/etc/pve/priv/authorized_keys
tmp=$(mktemp)
grep -vF "boat-dev-clone S1 sbx-node" "$ak" >"$tmp" || true
cat "$tmp" >"$ak"
rm -f "$tmp" /usr/local/bin/sbx-node /etc/sbx-node.toml
EOF
}

# ---------------------------------------------------------------- 4.4 firewall

cluster_fw() {
	local enable="$1"
	printf '[OPTIONS]\nenable: %s\npolicy_in: ACCEPT\npolicy_out: ACCEPT\n\n' "$enable"
	printf '[IPSET sbx-gateway] # %s: allowed tunnel endpoint(s); empty in S1\n\n' "$COMMENT"
	printf '[IPSET sbx-deny] # %s: private and special ranges\n' "$COMMENT"
	printf '%s\n' 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4
	printf '\n[IPSET sbx-deny-public] # %s: own public egress IPs (hairpin NAT), empty in the PoC\n' "$COMMENT"
	local ip
	for ip in $DENY_PUBLIC_IPS; do printf '%s\n' "$ip"; done
	# ipset hash:net rejects /0, so all of IPv6 is two /1 halves.
	printf '\n[IPSET sbx-deny6] # %s: all IPv6 (NDP is allowed by the ndp option)\n::/1\n8000::/1\n' "$COMMENT"
	printf '\n[group sbx-egress] # %s\n' "$COMMENT"
	printf 'OUT DROP -dest +sbx-deny-public\nOUT ACCEPT -dest +sbx-gateway -p tcp -dport 443\nOUT DROP -dest +sbx-deny\nOUT DROP -dest +sbx-deny6\n'
}

host_fw() {
	printf '[OPTIONS]\n# %s: the host is not filtered. Allow invalid conntrack state so that\n' "$COMMENT"
	printf '# bridged traffic of existing guests is never dropped by PVEFW-FORWARD.\nenable: 0\nnf_conntrack_allow_invalid: 1\n'
}

# fw_checks prints one "name ok|fail" line per check run from this Mac and on the host.
fw_checks() {
	local guests="$1"
	if ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then echo "ssh-tailscale ok"; else echo "ssh-tailscale fail"; fi
	if ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOST_LAN" true 2>/dev/null; then echo "ssh-lan ok"; else echo "ssh-lan fail"; fi
	local ip
	for ip in "$TS_IP" "$LAN_IP"; do
		if curl -sS -o /dev/null --max-time 10 --cacert "$CFG_DIR/pve-root-ca.pem" --resolve "pve:8006:$ip" https://pve:8006/ 2>/dev/null; then
			echo "https-$ip ok"
		else
			echo "https-$ip fail"
		fi
	done
	local id
	while read -r id ip; do
		[[ -n "$ip" ]] || continue
		if ping -c 2 -t 4 "$ip" >/dev/null 2>&1; then echo "ping-guest-$id-$ip ok"; else echo "ping-guest-$id-$ip fail"; fi
		if ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "ping -c 2 -W 2 $ip" >/dev/null 2>&1; then
			echo "host-ping-guest-$id-$ip ok"
		else
			echo "host-ping-guest-$id-$ip fail"
		fi
	done <<<"$guests"
	for ip in $TS_PEERS; do
		if ping -c 3 -t 6 "$ip" >/dev/null 2>&1; then echo "ping-tailscale-$ip ok"; else echo "ping-tailscale-$ip fail"; fi
	done
}

# guest_ips prints "<vmid> <lan ip>" for every running VM and container on vmbr0.
guest_ips() {
	remote <<'EOF2'
list=$(
	qm list | awk 'NR>1 && $3=="running" {print "qm", $1}'
	pct list | awk 'NR>1 && $2=="running" {print "pct", $1}'
)
while read -r kind id; do
	mac=$($kind config "$id" | grep -E '^net[0-9]+:' | grep -oiE '([0-9a-f]{2}:){5}[0-9a-f]{2}' | head -1 || true)
	ip=""
	if [ -n "$mac" ]; then
		ip=$(ip neigh show dev vmbr0 | grep -i "$mac" | awk '{print $1}' | grep -E '^[0-9.]+$' | head -1 || true)
	fi
	echo "$id ${ip:-}"
done <<<"$list"
EOF2
}

guest_status() {
	remote <<'EOF'
qm list | awk 'NR>1 {print "qm", $1, $3}'
pct list | awk 'NR>1 {print "pct", $1, $2}'
EOF
}

step_fw() {
	log "fw: datacenter firewall with IPSets and group sbx-egress, safe enable with automatic rollback"
	local tmpc tmph
	tmpc=$(mktemp)
	tmph=$(mktemp)
	cluster_fw 0 >"$tmpc"
	host_fw >"$tmph"
	if ((DRY)); then
		echo "--- cluster.fw (written with enable: 0, then enabled via API) ---"
		cat "$tmpc"
		echo "--- host.fw ---"
		cat "$tmph"
	fi
	local state
	state=$(remote "NODE=$NODE" <<'EOF'
enabled=$(pvesh get /cluster/firewall/options --output-format json | grep -o '"enable":[01]' | cut -d: -f2 || true)
echo "enabled=${enabled:-0}"
[ -e /etc/pve/firewall/cluster.fw ] && echo "cluster=present" || echo "cluster=absent"
[ -e /etc/pve/nodes/$NODE/host.fw ] && echo "host=present" || echo "host=absent"
EOF
)
	if ((DRY)); then
		echo "+ arm rollback timer, enable, wait 30 s, compare checks, stop timer"
		rm -f "$tmpc" "$tmph"
		return 0
	fi
	log "fw: current state: $(echo "$state" | tr '\n' ' ')"
	# Step 1: files with enable: 0.
	local cur_cluster cur_host
	cur_cluster=$(ssh -o BatchMode=yes "$HOST" "cat /etc/pve/firewall/cluster.fw 2>/dev/null || true")
	cur_host=$(ssh -o BatchMode=yes "$HOST" "cat /etc/pve/nodes/$NODE/host.fw 2>/dev/null || true")
	if [[ "$state" == *"enabled=1"* ]]; then
		log "fw: already enabled; verifying only"
	else
		# Existing files are only accepted if they are exactly what this step writes.
		if [[ -n "$cur_host" && "$cur_host" != "$(cat "$tmph")" ]]; then
			die "fw: /etc/pve/nodes/$NODE/host.fw exists and is not ours; refusing"
		fi
		if [[ -n "$cur_cluster" && "$cur_cluster" != "$(cluster_fw 0)" ]]; then
			die "fw: /etc/pve/firewall/cluster.fw exists and is not ours; refusing"
		fi
		scp -q "$tmph" "$HOST:/tmp/sbx-host.fw"
		scp -q "$tmpc" "$HOST:/tmp/sbx-cluster.fw"
		remote "NODE=$NODE" <<'EOF'
cat /tmp/sbx-host.fw >/etc/pve/nodes/$NODE/host.fw
cat /tmp/sbx-cluster.fw >/etc/pve/firewall/cluster.fw
rm -f /tmp/sbx-host.fw /tmp/sbx-cluster.fw
out=$(pve-firewall compile 2>&1)
if echo "$out" | grep -iE 'error|warning|failed|unable' >&2; then
	echo "fw: pve-firewall compile reported problems" >&2
	exit 1
fi
echo "fw: compile ok"
EOF
	fi
	rm -f "$tmpc" "$tmph"

	# Step 2: the world before.
	local guests before_status before
	guests=$(guest_ips)
	before_status=$(guest_status)
	log "fw: running guests and LAN IPs:"$'\n'"$guests"
	before=$(fw_checks "$guests")
	log "fw: checks before:"$'\n'"$before"
	[[ "$before" == *"ssh-tailscale ok"* ]] || die "fw: ssh over Tailscale fails before any change"

	if [[ "$state" != *"enabled=1"* ]]; then
		# Steps 3 and 4: rollback timer, then the main switch.
		remote <<'EOF'
systemctl stop sbx-fw-rollback.timer 2>/dev/null || true
systemctl reset-failed sbx-fw-rollback.service sbx-fw-rollback.timer 2>/dev/null || true
systemd-run --quiet --unit=sbx-fw-rollback --on-active=5min /usr/bin/pvesh set /cluster/firewall/options --enable 0
systemctl is-active --quiet sbx-fw-rollback.timer
pvesh set /cluster/firewall/options --enable 1
echo "fw: enabled, rollback armed for 5 min"
EOF
		log "fw: waiting 30 s for pve-firewall to apply"
		sleep 30
	fi

	# Step 5: the same checks plus host-side checks.
	local after after_status hostcheck failed=0
	after=$(fw_checks "$guests")
	after_status=$(guest_status)
	log "fw: checks after:"$'\n'"$after"
	local line name
	while read -r name line; do
		[[ "$line" == "ok" ]] || continue
		if ! grep -qx "$name ok" <<<"$after"; then
			log "fw: REGRESSION: $name"
			failed=1
		fi
	done <<<"$before"
	if [[ "$before_status" != "$after_status" ]]; then
		log "fw: REGRESSION: guest status changed"$'\n'"$(diff <(echo "$before_status") <(echo "$after_status") || true)"
		failed=1
	fi
	hostcheck=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" '
		pve-firewall status
		if iptables-save | grep -E -- "(tap|veth)1[0-9]{2}i" >/dev/null; then echo "rules-on-existing-guests"; fi
		if ip6tables-save | grep -E -- "(tap|veth)1[0-9]{2}i" >/dev/null; then echo "rules6-on-existing-guests"; fi
		echo "bridge-nf-call-iptables=$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)"
		iptables -S PVEFW-FORWARD 2>/dev/null | grep -q "ctstate INVALID -j DROP" && echo "invalid-drop-present" || true
	' 2>&1 || echo "host-unreachable")
	log "fw: host: $(echo "$hostcheck" | tr '\n' ' ')"
	if [[ "$hostcheck" != *"Status: enabled/running"* || "$hostcheck" == *"existing-guests"* || "$hostcheck" == *"invalid-drop-present"* || "$hostcheck" == *"host-unreachable"* ]]; then
		log "fw: REGRESSION: host-side check failed"
		failed=1
	fi

	if ((failed)); then
		log "fw: checks failed; NOT cancelling the rollback timer. The firewall switches off within 5 min."
		exit 1
	fi
	# Step 6: everything that was green is still green.
	remote <<'EOF'
systemctl stop sbx-fw-rollback.timer 2>/dev/null || true
echo "fw: rollback timer cancelled"
EOF
	log "fw: ok"
}

revert_fw() {
	remote "NODE=$NODE" <<'EOF'
pvesh set /cluster/firewall/options --enable 0
sleep 15
rm -f /etc/pve/firewall/cluster.fw /etc/pve/nodes/$NODE/host.fw
EOF
}

# ---------------------------------------------------------------- 4.6 template 599

step_template() {
	log "template: $TEMPLATE_VMID sbx-ubuntu-poc from a thin snapshot of base-9000-disk-0, sanitized offline"
	local_run scp -q "$HERE/template-sanitize.sh" "$HOST:/tmp/sbx-template-sanitize.sh"
	remote "ID=$TEMPLATE_VMID" "MAC=$TEMPLATE_MAC" "COMMENT=$COMMENT" <<'EOF'
if qm config "$ID" 2>/dev/null | grep -q '^template: 1'; then
	echo "template: $ID already a template"
	lvs -o lv_name,lv_tags pve/base-$ID-disk-0
	exit 0
fi
if qm config "$ID" >/dev/null 2>&1; then
	echo "template: VM $ID exists but is not a template; run 'setup.sh revert template' first" >&2
	exit 1
fi
lvs pve/vm-$ID-disk-0 >/dev/null 2>&1 || lvcreate -s -kn -n vm-$ID-disk-0 --addtag sbx-tpl pve/base-9000-disk-0
lvchange -ay pve/vm-$ID-disk-0
# 9000 is a personal dev template: sanitize the root filesystem before 599 ever boots.
mnt=/mnt/sbx-tpl
mkdir -p "$mnt"
loop=$(losetup -P --show -f /dev/pve/vm-$ID-disk-0)
trap 'umount "$mnt" 2>/dev/null || true; losetup -d "$loop" 2>/dev/null || true' EXIT
root_part=$(blkid -t LABEL=cloudimg-rootfs -o device "$loop"p* | head -1)
mount "$root_part" "$mnt"
bash /tmp/sbx-template-sanitize.sh "$mnt"
fstrim "$mnt" 2>/dev/null || echo "template: fstrim not supported on the loop device, skipped"
umount "$mnt"
losetup -d "$loop"
trap - EXIT
rm -f /tmp/sbx-template-sanitize.sh
qm create "$ID" --pool sandbox --name sbx-ubuntu-poc --description "$COMMENT template" --tags sbx-tpl \
	--machine q35 --cpu host --ostype l26 --scsihw virtio-scsi-single --agent enabled=1,fstrim_cloned_disks=1 \
	--serial0 socket --vga std --cores 2 --memory 2048 --balloon 0 \
	--net0 "virtio=$MAC,bridge=sbx0,firewall=1" \
	--ide2 local-lvm:cloudinit --ipconfig0 ip=dhcp --ciuser sbx
qm set "$ID" --scsi0 "local-lvm:vm-$ID-disk-0,discard=on,iothread=1,ssd=1" --boot order=scsi0
pvesh set /nodes/$(hostname)/qemu/$ID/firewall/options --enable 1 --policy_in DROP --policy_out ACCEPT \
	--dhcp 1 --ndp 1 --radv 0 --macfilter 1 --ipfilter 0
pvesh create /nodes/$(hostname)/qemu/$ID/firewall/rules --type group --action sbx-egress --iface net0 --enable 1
qm template "$ID"
qm config "$ID" | grep -q '^template: 1'
lvs -o lv_name,lv_tags,origin pve/base-$ID-disk-0
lvs -o lv_name,lv_attr pve/base-9000-disk-0
echo "template: ok"
EOF
}

revert_template() {
	remote "ID=$TEMPLATE_VMID" <<'EOF'
qm stop "$ID" 2>/dev/null || true
qm destroy "$ID" --purge 1 || true
lvremove -y pve/vm-$ID-disk-0 2>/dev/null || true
EOF
}

# ---------------------------------------------------------------- status

step_status() {
	remote "ID=$TEMPLATE_VMID" "NODE=$NODE" <<'EOF'
s() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "MISS  $1"; fi; }
s "user sbx@pve"                "pveum user list --output-format json | grep -q '\"userid\":\"sbx@pve\"'"
s "token sbx@pve!poc"           "pveum user token list sbx@pve --output-format json | grep -q '\"tokenid\":\"poc\"'"
s "role SbxPoC"                 "pveum role list --output-format json | grep -q '\"roleid\":\"SbxPoC\"'"
s "pool sandbox"                "pvesh get /pools/sandbox"
s "dnsmasq installed, disabled" "dpkg -s dnsmasq && ! systemctl is-enabled dnsmasq.service"
s "ip_forward=1"                "[ \$(sysctl -n net.ipv4.ip_forward) = 1 ]"
s "ipv6 forwarding=0"           "[ \$(sysctl -n net.ipv6.conf.all.forwarding) = 0 ]"
s "zone sbx"                    "pvesh get /cluster/sdn/zones/sbx"
s "vnet sbx0 up"                "ip link show sbx0"
s "dnsmasq@sbx running"         "systemctl is-active dnsmasq@sbx"
s "SNAT 10.88.0.0/24"           "iptables -t nat -S POSTROUTING | grep -q 10.88.0.0/24"
s "datacenter firewall enabled" "pvesh get /cluster/firewall/options --output-format json | grep -q '\"enable\":1'"
s "host.fw enable 0"            "grep -q '^enable: 0' /etc/pve/nodes/$NODE/host.fw"
s "group sbx-egress"            "grep -q 'group sbx-egress' /etc/pve/firewall/cluster.fw"
s "rollback timer inactive"     "! systemctl is-active sbx-fw-rollback.timer"
s "sbx-node installed"          "test -x /usr/local/bin/sbx-node && test -f /etc/sbx-node.toml"
s "sbx-node key"                "grep -q 'boat-dev-clone S1 sbx-node' /etc/pve/priv/authorized_keys"
s "template $ID"                "qm config $ID | grep -q '^template: 1'"
s "base-$ID-disk-0 tagged"      "lvs -o lv_tags --noheadings pve/base-$ID-disk-0 | grep -q sbx-tpl"
EOF
}

# ---------------------------------------------------------------- main

usage() {
	sed -n '2,9p' "$0"
	exit 2
}

cmd="${1:-}"
case "$cmd" in
user | net | sdn | node | fw | template | status) "step_$cmd" ;;
revert)
	case "${2:-}" in
	user | net | sdn | node | fw | template) "revert_$2" ;;
	*) usage ;;
	esac
	;;
*) usage ;;
esac
