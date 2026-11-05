#!/bin/sh
# Generate installation secrets once. Existing values always win.
set -eu
umask 077
root=${UMIAK_SECRETS_ROOT:-/secrets}
mkdir -p "$root/database" "$root/pve"
if [ ! -s "$root/database/password" ]; then
 openssl rand -hex 32 > "$root/database/password.new"
 mv "$root/database/password.new" "$root/database/password"
fi
chown -R 1000:1000 "$root/database" "$root/pve"
chmod 700 "$root/database" "$root/pve"
sh /service-secrets.sh
# Only these consumers can read each generated copy.
cp "$root/database/password" "$root/database/gateway-password"
chown 65532:65532 "$root/database/gateway-password"
chmod 600 "$root/database/gateway-password"
chmod 711 "$root/database" "$root"
chown 1000:1000 "$root/payload-secret"

# Worker receives only its gateway token and public SSH user CA.
cp "$root/gateway/worker-gateway-token" "$root/worker/worker-gateway-token"
cp "$root/gateway/ssh_user_ca.pub" "$root/worker/ssh_user_ca.pub"
chown 1000:1000 "$root/worker/worker-gateway-token" "$root/worker/ssh_user_ca.pub"
chmod 600 "$root/worker/worker-gateway-token" "$root/worker/ssh_user_ca.pub"

mkdir -p /network-config
chown 1000:1000 /network-config
chmod 755 /network-config
if [ ! -f /network-config/quickstart-network.json ] && [ -f "$root/pve/quickstart-network.json" ]; then
 cp "$root/pve/quickstart-network.json" /network-config/quickstart-network.json
 chown 1000:1000 /network-config/quickstart-network.json
 chmod 644 /network-config/quickstart-network.json
fi
