#!/bin/sh
set -eu
# A dedicated host address is required; no open relay or unauthenticated fallback.
: "${SBX_TURN_IP:?set the dedicated TURN listening/relay IP}"
: "${SBX_TURN_REALM:?set the TURN DNS realm}"
case "$SBX_TURN_IP" in *[!0-9.]*|'') echo 'SBX_TURN_IP must be an IPv4 address' >&2; exit 1;; esac
case "$SBX_TURN_REALM" in *[!A-Za-z0-9.-]*|'') echo 'invalid TURN realm' >&2; exit 1;; esac
secret=$(cat /secrets/auth-secret)
case "$secret" in *[!A-Za-z0-9+/=_-]*|'') echo 'invalid TURN secret' >&2; exit 1;; esac
[ "${#secret}" -ge 43 ] || { echo 'TURN secret must encode at least 32 random bytes' >&2; exit 1; }
umask 077
config=$(mktemp /run/turn/config.XXXXXX)
cat >"$config" <<CONF
listening-port=3478
tls-listening-port=443
listening-ip=$SBX_TURN_IP
relay-ip=$SBX_TURN_IP
external-ip=$SBX_TURN_IP
realm=$SBX_TURN_REALM
fingerprint
use-auth-secret
static-auth-secret=$secret
cert=/secrets/tls.crt
pkey=/secrets/tls.key
min-port=49152
max-port=65535
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
