#!/bin/sh
set -eu
run=${SBX_TURN_RUN_DIR:-/run/turn}
# Compose healthcheck: the relay egress table is exactly what this start installed.
if [ "${1:-}" = health ]; then
 [ -s "$run/guard.nft" ] && [ "$(nft -s list table inet sbx_turn 2>/dev/null)" = "$(cat "$run/guard.nft")" ]
 exit
fi
# Explicit listener address; no open relay or unauthenticated fallback.
: "${SBX_TURN_IP:?set the dedicated TURN listening/relay IP}"
: "${SBX_TURN_REALM:?set the TURN DNS realm}"
case "$SBX_TURN_IP" in *[!0-9.]*|'') echo 'SBX_TURN_IP must be an IPv4 address' >&2; exit 1;; esac
printf '%s\n' "$SBX_TURN_IP" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++)if($i=="" || $i>255)exit 1}' || { echo 'invalid TURN IPv4 address' >&2; exit 1; }
case "$SBX_TURN_REALM" in *[!A-Za-z0-9.-]*|'') echo 'invalid TURN realm' >&2; exit 1;; esac
port=${SBX_TURN_PORT:-3478}
tls_port=${SBX_TURN_TLS_PORT:-443}
relay_min=${SBX_TURN_RELAY_MIN:-61000}
relay_max=${SBX_TURN_RELAY_MAX:-65535}
for value in "$port" "$tls_port" "$relay_min" "$relay_max"; do
 case "$value" in ''|*[!0-9]*) echo 'invalid TURN port' >&2; exit 1;; esac
 [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || { echo 'TURN port out of range' >&2; exit 1; }
done
[ "$relay_min" -le "$relay_max" ] || { echo 'invalid TURN relay range' >&2; exit 1; }
uid=${SBX_TURN_UID:-3478}
case "$uid" in ''|*[!0-9]*) echo 'invalid TURN uid' >&2; exit 1;; esac
[ "$uid" -ge 1 ] || { echo 'turnserver must not run as root' >&2; exit 1; }
secrets=${SBX_TURN_SECRETS_DIR:-/secrets}
interval=${SBX_TURN_GUARD_INTERVAL:-2}
case "$interval" in ''|*[!0-9.]*) echo 'invalid TURN guard interval' >&2; exit 1;; esac
# Relay ports must never be ephemeral ports of this namespace: a relay could
# otherwise reach a client socket of another process (S10 spec 9.2).
read -r eph_min eph_max <"${SBX_TURN_SYSCTL_DIR:-/proc/sys/net/ipv4}/ip_local_port_range"
[ "$relay_max" -lt "$eph_min" ] || [ "$relay_min" -gt "$eph_max" ] || {
 echo "TURN relay range overlaps the ephemeral ports $eph_min-$eph_max" >&2; exit 1; }
[ -s "$secrets/tls.crt" ] && [ -s "$secrets/tls.key" ] || { echo 'TURN TLS certificate and key are required' >&2; exit 1; }
secret=$(cat "$secrets/auth-secret")
case "$secret" in *[!A-Za-z0-9+/=_-]*|'') echo 'invalid TURN secret' >&2; exit 1;; esac
[ "${#secret}" -ge 43 ] || { echo 'TURN secret must encode at least 32 random bytes' >&2; exit 1; }

# Own network namespace: the TURN address lives on lo here, so relay <-> relay
# stays inside and no other process owns a socket on it. On the host network
# that address belongs to the host and its services; refuse to start there.
if ip -4 -o addr show | awk -v a="$SBX_TURN_IP/" '$2 != "lo" && index($4, a) == 1 {found = 1} END {exit !found}'; then
 echo 'TURN address already assigned: run turn in its own network namespace, not on the host network' >&2
 exit 1
fi
listen_ip=${SBX_TURN_LISTEN_IP:-$(ip -4 -o addr show scope global | awk '$2 != "lo" {split($4, a, "/"); print a[1]; exit}')}
case "$listen_ip" in *[!0-9.]*|'') echo 'no TURN listening address in this namespace' >&2; exit 1;; esac
ip -4 addr replace "$SBX_TURN_IP/32" dev lo

# The peer allowlist below is by IP only: a permission for our own address
# lets an allocation reach any UDP port of it. Relay sockets of this server
# ($uid, bound to $SBX_TURN_IP:$relay_min-$relay_max) may only send to relay
# ports of the same address (relay <-> relay); the table is replaced on every
# start, so turnserver never runs without it.
nft -f - <<NFT
table inet sbx_turn
delete table inet sbx_turn
table inet sbx_turn {
 chain relay_egress {
  type filter hook output priority filter; policy accept;
  meta skuid $uid ip saddr $SBX_TURN_IP udp sport $relay_min-$relay_max ip daddr $SBX_TURN_IP udp dport $relay_min-$relay_max accept
  meta skuid $uid ip saddr $SBX_TURN_IP udp sport $relay_min-$relay_max counter drop comment "sbx-turn relay to non-relay peer"
  meta skuid $uid meta nfproto ipv6 udp sport $relay_min-$relay_max counter drop comment "sbx-turn ipv6 relay"
 }
}
NFT

umask 077
nft -s list table inet sbx_turn >"$run/guard.nft"
install -d -m 0700 -o "$uid" -g "$uid" "$run/state"
# Mode first: without CAP_FOWNER root cannot chmod a file it no longer owns.
for f in tls.crt tls.key; do
 cat "$secrets/$f" >"$run/$f"
 chmod 0400 "$run/$f"
 chown "$uid:$uid" "$run/$f"
done
config="$run/turnserver.conf"
cat >"$config" <<CONF
listening-port=$port
tls-listening-port=$tls_port
listening-ip=$listen_ip
relay-ip=$SBX_TURN_IP
external-ip=$SBX_TURN_IP
pidfile=$run/state/turnserver.pid
realm=$SBX_TURN_REALM
fingerprint
# rtc-turn 0.21.1 cannot renew ChannelBind after 438; Refresh still rechecks REST expiry.
stale-nonce=0
use-auth-secret
static-auth-secret=$secret
cert=$run/tls.crt
pkey=$run/tls.key
min-port=$relay_min
max-port=$relay_max
denied-peer-ip=0.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=$SBX_TURN_IP
no-tcp-relay
no-multicast-peers
user-quota=16
max-allocate-lifetime=60
total-quota=400
max-bps=3000000
no-software-attribute
no-cli
log-file=stdout
simple-log
CONF
unset secret
chmod 0400 "$config"
chown "$uid:$uid" "$config"
# Fail closed: this shell stays the container's init and watches the table; if it
# disappears or changes (root in this namespace, e.g. docker exec), init exits and
# the kernel kills turnserver with the PID namespace (root lacks CAP_KILL for the
# relay uid; init itself cannot be killed from inside). The restart policy starts
# again with a fresh table. A wrapper reports turnserver's own exit with USR2.
trap 'exit 143' TERM INT
trap 'exit "$(cat "$run/server.status" 2>/dev/null || echo 1)"' USR2
expected=$(cat "$run/guard.nft")
{
 # Drop to the relay uid; keep only the bind capability for privileged listener ports.
 # The bounding set is the container's cap_add; no-new-privileges blocks regaining the rest.
 setpriv --reuid="$uid" --regid="$uid" --clear-groups \
  --inh-caps=-all,+net_bind_service --ambient-caps=-all,+net_bind_service \
  turnserver -c "$config" &
 echo "$!" >"$run/server.pid"
 status=0
 wait "$!" || status=$?
 echo "$status" >"$run/server.status"
 kill -USR2 $$
} &
while :; do
 sleep "$interval" &
 wait "$!" || true
 [ "$(nft -s list table inet sbx_turn 2>/dev/null)" = "$expected" ] && continue
 echo 'sbx-turn: relay egress table removed or changed, stopping turnserver' >&2
 # Outside a PID namespace (tests) init's exit would not stop it.
 kill "$(cat "$run/server.pid")" 2>/dev/null || true
 exit 1
done
