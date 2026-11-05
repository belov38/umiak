#!/bin/sh
# Per-service secrets for the owner installation. Existing generated values are preserved.
set -eu
umask 077

S=${UMIAK_SECRETS_ROOT:-/secrets}
GW=$S/gateway
NODE_UID=1000

mkdir -p "$S/api" "$S/worker"

# Base64 of N random bytes.
rand() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
# URL-safe token of 32 random bytes.
token() { rand 32 | tr '+/' '-_' | tr -d '='; }

# new FILE CMD...: writes the output of CMD to FILE unless FILE exists.
# (POSIX sh has no local variables: helper variables have their own names.)
new() {
	new_f=$1
	shift
	[ -s "$new_f" ] && return 0
	new_t=$(mktemp "$new_f.XXXXXX")
	"$@" >"$new_t"
	mv "$new_t" "$new_f"
	echo "created ${new_f#"$S"/}"
}

# synced FILE CMD...: writes the output of CMD to FILE when it differs.
synced() {
	sync_f=$1
	shift
	sync_t=$(mktemp "$sync_f.XXXXXX")
	"$@" >"$sync_t"
	if [ -f "$sync_f" ] && cmp -s "$sync_t" "$sync_f"; then
		rm -f "$sync_t"
		return 0
	fi
	mv "$sync_t" "$sync_f"
	echo "updated ${sync_f#"$S"/}"
}

data_keys() { printf '{"current":1,"keys":{"1":"%s"}}\n' "$(rand 32)"; }
line() { printf '%s\n' "$1"; }
no_newline() { tr -d '\n' <"$1"; }
tokens_json() { jq -cn --arg t "$1" '{gateway: [$t]}'; }

# An ed25519 key pair in a scratch directory; prints the private key or,
# with "pub", only the public key (comment dropped).
ed25519() {
	key_dir=$(mktemp -d)
	ssh-keygen -q -t ed25519 -N '' -C "$1" -f "$key_dir/k"
	if [ "${2:-}" = pub ]; then
		cut -d' ' -f1,2 "$key_dir/k.pub"
	else
		cat "$key_dir/k"
	fi
	rm -rf "$key_dir"
}

gw_api_token() { tr -d '\n' <"$GW/api-token"; }
gw_outbound_token() {
	gw_token=$(jq -er '.api[0] // empty' "$GW/service-tokens.json") || {
		echo "gateway/service-tokens.json has no api token" >&2
		exit 1
	}
	line "$gw_token"
}
gw_host_keys() {
	for host_key in "$GW/ssh_host_ed25519_key.pub" "$GW/ssh_host_ecdsa_key.pub"; do
		if [ -f "$host_key" ]; then cut -d' ' -f1,2 "$host_key"; fi
	done
}

# S6 key ring of the worker and the api (also the old manual location).
new "$S/data-keys.json" data_keys
synced "$S/api/data-keys.json" cat "$S/data-keys.json"
synced "$S/worker/data-keys.json" cat "$S/data-keys.json"

# api: HMAC key of list cursors (UMIAK_API_CURSOR_KEY).
new "$S/api/cursor-key" line "$(rand 32)"

# api: tokens of the gateway, the SSH login CA and the gateway host keys,
# from gateway/ when the S4 gateway is in the stack.
if [ -s "$GW/api-token" ]; then
	synced "$S/api/service-tokens.json" tokens_json "$(gw_api_token)"
else
	new "$S/api/service-tokens.json" tokens_json "$(token)"
fi
if [ -s "$GW/service-tokens.json" ]; then
	synced "$S/api/gateway-token" gw_outbound_token
else
	new "$S/api/gateway-token" line "$(token)"
fi
if [ -s "$GW/ssh_login_ca" ]; then
	synced "$S/api/ssh-login-ca" cat "$GW/ssh_login_ca"
else
	new "$S/api/ssh-login-ca" ed25519 umiak-dev-login-ca
fi
if [ -s "$GW/ssh_host_ed25519_key.pub" ]; then
	synced "$S/api/ssh-host-keys.pub" gw_host_keys
else
	# Stand-in host key until the S4 gateway runs (its private half is
	# thrown away: nothing serves SSH here).
	new "$S/api/ssh-host-keys.pub" ed25519 umiak-dev-host pub
fi

# Owners and modes; only root can hand files to other uids.
own() {
	[ "$(id -u)" = 0 ] || return 0
	chown -R "$1:$1" "$2"
	chmod 700 "$2"
	find "$2" -type f -exec chmod 600 {} +
}
own "$NODE_UID" "$S/api"
own "$NODE_UID" "$S/worker"
if [ "$(id -u)" = 0 ]; then
	chown "$NODE_UID:$NODE_UID" "$S/data-keys.json"
	chmod 600 "$S/data-keys.json"
fi
echo "secrets ready"
