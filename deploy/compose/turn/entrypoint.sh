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
secrets=${SBX_TURN_SECRETS_DIR:-/secrets}
run=${SBX_TURN_RUN_DIR:-/run/turn}
[ -s "$secrets/tls.crt" ] && [ -s "$secrets/tls.key" ] || { echo 'TURN TLS certificate and key are required' >&2; exit 1; }
secret=$(cat "$secrets/auth-secret")
case "$secret" in *[!A-Za-z0-9+/=_-]*|'') echo 'invalid TURN secret' >&2; exit 1;; esac
[ "${#secret}" -ge 43 ] || { echo 'TURN secret must encode at least 32 random bytes' >&2; exit 1; }
umask 077
config=$(mktemp "$run/config.XXXXXX")
cat >"$config" <<CONF
listening-port=$port
tls-listening-port=$tls_port
listening-ip=$SBX_TURN_IP
relay-ip=$SBX_TURN_IP
external-ip=$SBX_TURN_IP
realm=$SBX_TURN_REALM
fingerprint
use-auth-secret
static-auth-secret=$secret
cert=$secrets/tls.crt
pkey=$secrets/tls.key
min-port=$relay_min
max-port=$relay_max
denied-peer-ip=0.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=$SBX_TURN_IP
no-tcp-relay
no-multicast-peers
no-cli
no-software-attribute
user-quota=4
total-quota=400
max-bps=3000000
no-dtls
log-file=stdout
simple-log
CONF
unset secret
exec turnserver -c "$config"
