#!/bin/sh
# One-shot dev secrets of the local stack (S7 plan decision 13), run by the
# `secrets-init` service on every `up`. Writes into /secrets
# (deploy/compose/secrets, git-ignored), one directory per consumer, because
# compose mounts directories (a file mount needs its file before any
# container is created):
#   data-keys.json        S6 key ring, the source of the copies below
#   api/                  data-keys.json, cursor-key, service-tokens.json,
#                         gateway-token, ssh-login-ca, ssh-host-keys.pub
#   worker/               data-keys.json
#   keycloak/             oauth2-proxy-client-secret, sbx-worker-client-secret
#   oauth2-proxy/         client-secret, cookie-secret
# Rules:
#   - a generated secret is written only when missing, never replaced;
#   - copies and the files derived from /secrets/gateway (written by the S4
#     `gateway-secrets` service) are rewritten whenever they differ from
#     their source;
#   - every directory and file then gets its consumer's owner (on a Linux host
#     the containers run as other uids than the host user).
set -eu
umask 077

S=/secrets
GW=$S/gateway
# node in the api and worker images, keycloak in the Keycloak image.
NODE_UID=1000
KEYCLOAK_UID=1000
# distroless nonroot in the oauth2-proxy image.
OAUTH2_PROXY_UID=65532

mkdir -p "$S/api" "$S/worker" "$S/keycloak" "$S/oauth2-proxy"

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

# api: HMAC key of list cursors (SBX_API_CURSOR_KEY).
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
	new "$S/api/ssh-login-ca" ed25519 sbx-dev-login-ca
fi
if [ -s "$GW/ssh_host_ed25519_key.pub" ]; then
	synced "$S/api/ssh-host-keys.pub" gw_host_keys
else
	# Stand-in host key until the S4 gateway runs (its private half is
	# thrown away: nothing serves SSH here).
	new "$S/api/ssh-host-keys.pub" ed25519 sbx-dev-host pub
fi

# Keycloak and oauth2-proxy: client secrets of the realm `sbx`, cookie key.
new "$S/keycloak/oauth2-proxy-client-secret" line "$(token)"
new "$S/keycloak/sbx-worker-client-secret" line "$(token)"
# oauth2-proxy reads its secret files as they are: no trailing newline.
synced "$S/oauth2-proxy/client-secret" no_newline "$S/keycloak/oauth2-proxy-client-secret"
# Exactly 32 bytes (an AES-256 key as is).
new "$S/oauth2-proxy/cookie-secret" printf '%s' "$(rand 24 | tr '+/' '-_')"

# Owners and modes; only root can hand files to other uids.
own() {
	[ "$(id -u)" = 0 ] || return 0
	chown -R "$1:$1" "$2"
	chmod 700 "$2"
	find "$2" -type f -exec chmod 600 {} +
}
own "$NODE_UID" "$S/api"
own "$NODE_UID" "$S/worker"
own "$KEYCLOAK_UID" "$S/keycloak"
own "$OAUTH2_PROXY_UID" "$S/oauth2-proxy"
if [ "$(id -u)" = 0 ]; then
	chown "$NODE_UID:$NODE_UID" "$S/data-keys.json"
	chmod 600 "$S/data-keys.json"
fi
echo "secrets ready"
