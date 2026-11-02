#!/usr/bin/env bash
# umiak dev control plane: the dev CA, on the operator's Mac. deploy.sh runs it; it is
# idempotent. Dev only.
#
#   infra/dev-cp/dev-ca.sh
#
# Creates ca.pem and ca.key (ECDSA P-256, 10 years) in $CA_DIR (~/.config/umiak/dev-ca, mode 0700,
# files 0600) once. The gateway's dev-secrets on the CT issues the tunnel and the *.umiak.
# certificates with it (deploy.sh puts it into secrets/gateway); agents pin it as their tunnel
# CA. Name constraints limit it to the tunnel host and the port domain (names.sh), so trusting
# it on the Mac for previews vouches for nothing else, even if ca.key leaks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"

[[ $# -eq 0 ]] || {
	sed -n '2,11p' "$0"
	exit 2
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

command -v openssl >/dev/null || die "openssl is missing"
umask 077
mkdir -p "$CA_DIR"
chmod 700 "$CA_DIR"
cd "$CA_DIR"

# The constraints are fixed at creation; other names need a new CA (and new trust on the Mac).
permitted="$TUNNEL_HOST $PORT_DOMAIN"
if [[ -s ca.pem && -s ca.key ]]; then
	[[ "$(cat ca.names 2>/dev/null)" == "$permitted" ]] ||
		die "$CA_DIR/ca.pem is limited to '$(cat ca.names 2>/dev/null)', not '$permitted'. Move $CA_DIR away to create a new CA, then run deploy.sh and trust-mac.sh again"
elif [[ -e ca.pem || -e ca.key ]]; then
	die "only one of ca.pem and ca.key is in $CA_DIR; remove the other one too"
else
	log "new dev CA in $CA_DIR for $permitted"
	cfg=$(mktemp)
	trap 'rm -f "$cfg"' EXIT
	cat >"$cfg" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = umiak dev-cp CA $(openssl rand -hex 4)
O = umiak local development
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:$TUNNEL_HOST, permitted;DNS:$PORT_DOMAIN
EOF
	# PKCS#8 with a named curve: the gateway's dev-secrets loads PKCS#8 only, and Go rejects
	# explicit curve parameters.
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out ca.key.new 2>/dev/null
	openssl req -new -x509 -sha256 -key ca.key.new -days 3650 -config "$cfg" -out ca.pem.new
	mv ca.key.new ca.key
	mv ca.pem.new ca.pem
	printf '%s\n' "$permitted" >ca.names
fi
chmod 600 ./*
log "dev CA: $CA_DIR/ca.pem ($(openssl x509 -in ca.pem -noout -subject | sed 's/^subject= *//'))"
