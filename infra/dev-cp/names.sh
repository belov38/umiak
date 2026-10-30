# shellcheck shell=bash disable=SC2034 # the variables are used by the scripts that source it
# boat-dev-clone dev control plane: host names, Tailscale Serve mapping and the dev CA location.
# Sourced by deploy.sh, dev-ca.sh, smoke.sh and trust-mac.sh. Dev only: nothing here is a product
# default, and nothing Tailscale- or sslip.io-specific leaves infra/.

# CT 590 on the LAN (sandboxes reach only CT_IP:443) and on the tailnet (the operator's Mac).
CT_IP="${SBX_CP_IP:-192.168.68.90}"
CT_TAILNET_IP="${SBX_CP_TAILNET_IP:-100.64.10.7}"

# The CT's MagicDNS name. Tailscale Serve terminates TLS for it with a Let's Encrypt certificate
# that the Mac trusts as is: web, api and Keycloak are reached through it. deploy.sh checks the
# name against `tailscale status` on the CT.
TS_NAME="${SBX_DEVCP_TS_NAME:-sbx-dev-cp.tail0000.ts.net}"

# Serve mapping, "<https port>:<path>=<target>", one per word. Serve allows 443, 8443 and 10000;
# 443 of the tailnet address stays with the gateway (previews, below), so:
#   :8443  /    -> oauth2-proxy (S8: web, /api/*, /sbx-auth/*)
#   :8443  /v1  -> api public listener (S7, CLI and SDK)
#   :8443  /mcp -> MCP server (S11), with its protected resource metadata
#   :10000 /    -> Keycloak (S8)
# Targets are loopback ports of the CT; S7/S8 publish their services there.
SERVE="${SBX_DEVCP_SERVE:-8443:/=http://127.0.0.1:4180 8443:/v1=http://127.0.0.1:8080/v1 8443:/mcp=http://127.0.0.1:8090/mcp 8443:/.well-known/oauth-protected-resource/mcp=http://127.0.0.1:8090/.well-known/oauth-protected-resource/mcp 10000:/=http://127.0.0.1:8180}"
APP_ORIGIN="https://$TS_NAME:8443"
API_URL="https://$TS_NAME:8443"
MCP_URL="https://$TS_NAME:8443/mcp"
KEYCLOAK_URL="https://$TS_NAME:10000"
OIDC_ISSUER="$KEYCLOAK_URL/realms/sbx"
SSH_HOST="$TS_NAME"

# Names from the public wildcard DNS sslip.io (<a-b-c-d>.sslip.io resolves to a.b.c.d). It answers
# DNS only; traffic goes straight to the CT. Certificates come from the dev CA.
# Agent tunnel endpoint: sandboxes use public DNS and are not on the tailnet, so the LAN address.
TUNNEL_HOST="${SBX_DEVCP_TUNNEL_HOST:-tunnel.${CT_IP//./-}.sslip.io}"
TUNNEL_URL="wss://$TUNNEL_HOST/v1/connect"
# Port previews need a wildcard, which MagicDNS and Serve cannot give: *.sbx.<tailnet address>,
# served by the gateway on 443 of the tailnet address.
PORT_DOMAIN="${SBX_DEVCP_PORT_DOMAIN:-sbx.${CT_TAILNET_IP//./-}.sslip.io}"

# The dev CA (outside git) and its copy on the CT, both 0600.
CA_DIR="${SBX_DEVCP_CA_DIR:-${SBX_CONFIG_DIR:-$HOME/.config/sbx}/dev-ca}"
