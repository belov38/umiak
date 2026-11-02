#!/bin/sh
# Generate installation secrets once. Existing values always win.
set -eu
umask 077
root=${UMIAK_SECRETS_ROOT:-/secrets}
mkdir -p "$root/database" "$root/owner" "$root/pve"
if [ ! -s "$root/database/password" ]; then
 openssl rand -hex 32 > "$root/database/password.new"
 mv "$root/database/password.new" "$root/database/password"
fi
chown -R 1000:1000 "$root/database" "$root/owner" "$root/pve"
chmod 700 "$root/database" "$root/owner" "$root/pve"
sh /legacy-init.sh
# Only these consumers can read each generated copy.
cp "$root/database/password" "$root/database/gateway-password"
chown 65532:65532 "$root/database/gateway-password"
chmod 600 "$root/database/gateway-password"
chmod 711 "$root/database" "$root"
chown 1000:1000 "$root/payload-secret"
