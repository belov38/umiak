#!/usr/bin/env bash
# Issue a TURN server leaf using the existing constrained dev CA; never rotate that CA.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/names.sh"
umask 077
install -d -m 700 "$CA_DIR/turn"
verify_leaf() {
 openssl verify -CAfile "$CA_DIR/ca.pem" "$1" >/dev/null &&
 openssl x509 -in "$1" -text -noout | grep -q 'ASN1 OID: prime256v1' &&
 openssl x509 -in "$1" -text -noout | grep -q 'X509v3 Authority Key Identifier' &&
 python3 -c 'import ssl,sys; assert ("DNS",sys.argv[2]) in ssl._ssl._test_decode_cert(sys.argv[1])["subjectAltName"]' "$1" "$TURN_HOST"
}
if [[ -s "$CA_DIR/turn/tls.crt" && -s "$CA_DIR/turn/tls.key" ]] &&
 verify_leaf "$CA_DIR/turn/tls.crt" >/dev/null 2>&1 &&
 [[ "$(openssl x509 -in "$CA_DIR/turn/tls.crt" -pubkey -noout)" == "$(openssl pkey -in "$CA_DIR/turn/tls.key" -pubout 2>/dev/null)" ]] &&
 openssl x509 -in "$CA_DIR/turn/tls.crt" -checkend 2592000 -noout >/dev/null; then exit 0; fi
work=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$work"' EXIT
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out "$work/tls.key" 2>/dev/null
openssl req -new -key "$work/tls.key" -subj "/CN=$TURN_HOST" -out "$work/leaf.csr"
printf 'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$TURN_HOST" >"$work/leaf.ext"
openssl x509 -req -in "$work/leaf.csr" -CA "$CA_DIR/ca.pem" -CAkey "$CA_DIR/ca.key" -set_serial "0x$(openssl rand -hex 16)" -days 90 -sha256 -extfile "$work/leaf.ext" -out "$work/tls.crt" 2>/dev/null
verify_leaf "$work/tls.crt"
install -m 600 "$work/tls.key" "$CA_DIR/turn/tls.key"
install -m 644 "$work/tls.crt" "$CA_DIR/turn/tls.crt"
