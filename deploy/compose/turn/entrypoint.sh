#!/bin/sh
set -eu
# Explicit listener address; no open relay or unauthenticated fallback.
: "${SBX_TURN_IP:?set the dedicated TURN listening/relay IP}"
: "${SBX_TURN_REALM:?set the TURN DNS realm}"
case "$SBX_TURN_IP" in *[!0-9.]*|'') echo 'SBX_TURN_IP must be an IPv4 address' >&2; exit 1;; esac
printf '%s\n' "$SBX_TURN_IP" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++)if($i=="" || $i>255)exit 1}' || { echo 'invalid TURN IPv4 address' >&2; exit 1; }
case "$SBX_TURN_REALM" in *[!A-Za-z0-9.-]*|'') echo 'invalid TURN realm' >&2; exit 1;; esac
port=${SBX_TURN_PORT:-3478}
tls_port=${SBX_TURN_TLS_PORT:-443}
relay_min=${SBX_TURN_RELAY_MIN:-49152}
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
run=${SBX_TURN_RUN_DIR:-/run/turn}
[ -s "$secrets/tls.crt" ] && [ -s "$secrets/tls.key" ] || { echo 'TURN TLS certificate and key are required' >&2; exit 1; }
secret=$(cat "$secrets/auth-secret")
case "$secret" in *[!A-Za-z0-9+/=_-]*|'') echo 'invalid TURN secret' >&2; exit 1;; esac
[ "${#secret}" -ge 43 ] || { echo 'TURN secret must encode at least 32 random bytes' >&2; exit 1; }

# The peer allowlist below is by IP only: a permission for our own address
# lets an allocation reach any UDP port of it (other services on this host).
# Relay sockets of this server ($uid, bound to $SBX_TURN_IP:$relay_min-$relay_max)
# may only send to relay ports of the same address (relay <-> relay); the
# table is replaced on every start, so turnserver never runs without it.
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
install -d -m 0700 -o "$uid" -g "$uid" "$run/state"
install -m 0400 -o "$uid" -g "$uid" "$secrets/tls.crt" "$run/tls.crt"
install -m 0400 -o "$uid" -g "$uid" "$secrets/tls.key" "$run/tls.key"
config="$run/turnserver.conf"
cat >"$config" <<CONF
listening-port=$port
tls-listening-port=$tls_port
listening-ip=$SBX_TURN_IP
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
chown "$uid:$uid" "$config"
chmod 0400 "$config"
# Drop to the relay uid; keep only the bind capability for privileged listener ports.
exec setpriv --reuid="$uid" --regid="$uid" --clear-groups \
 --inh-caps=-all,+net_bind_service --ambient-caps=-all,+net_bind_service \
 --bounding-set=-all,+net_bind_service turnserver -c "$config"
