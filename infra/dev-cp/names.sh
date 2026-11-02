# shellcheck shell=bash disable=SC2034 # the variables are used by the scripts that source it
# umiak dev control plane: host names, Tailscale Serve mapping and the dev CA location.
# Sourced by deploy.sh, dev-ca.sh, smoke.sh and trust-mac.sh. Dev only: nothing here is a product
# default, and nothing Tailscale- or sslip.io-specific leaves infra/.

# CT 590 on the LAN (sandboxes reach only CT_IP:443) and on the tailnet (the operator's Mac).
CT_IP="${UMIAK_CP_IP:-192.168.68.90}"
CT_TAILNET_IP="${UMIAK_CP_TAILNET_IP:-100.64.10.7}"

# The CT's MagicDNS name. Tailscale Serve terminates TLS for it with a Let's Encrypt certificate
# that the Mac trusts as is: web, api and Keycloak are reached through it. deploy.sh checks the
# name against `tailscale status` on the CT.
TS_NAME="${UMIAK_DEVCP_TS_NAME:-umiak-dev-cp.tail0000.ts.net}"

# Serve mapping, "<https port>:<path>=<target>", one per word. Serve allows 443, 8443 and 10000;
# 443 of the tailnet address stays with the gateway (previews, below), so:
#   :8443  /    -> oauth2-proxy (S8: web, /api/*, /umiak-auth/*)
#   :8443  /v1  -> api public listener (S7, CLI and SDK)
#   :8443  /mcp -> MCP server (S11), with its protected resource metadata
#   :10000 /    -> Keycloak (S8)
# Targets are loopback ports of the CT; S7/S8 publish their services there.
SERVE="${UMIAK_DEVCP_SERVE:-8443:/=http://127.0.0.1:4180 8443:/v1=http://127.0.0.1:8080/v1 8443:/mcp=http://127.0.0.1:8090/mcp 8443:/.well-known/oauth-protected-resource/mcp=http://127.0.0.1:8090/.well-known/oauth-protected-resource/mcp 10000:/=http://127.0.0.1:8180}"
APP_ORIGIN="https://$TS_NAME:8443"
API_URL="https://$TS_NAME:8443"
MCP_URL="https://$TS_NAME:8443/mcp"
KEYCLOAK_URL="https://$TS_NAME:10000"
OIDC_ISSUER="$KEYCLOAK_URL/realms/umiak"
# web's sign-out (S8): after oauth2-proxy, Keycloak's end-session page returns to the app origin
# (the realm allows "$APP_ORIGIN/*" as post-logout redirect for the oauth2-proxy client).
LOGOUT_URL="$OIDC_ISSUER/protocol/openid-connect/logout?client_id=oauth2-proxy&post_logout_redirect_uri=$APP_ORIGIN/app"
SSH_HOST="$TS_NAME"

# Names from the public wildcard DNS sslip.io (<a-b-c-d>.sslip.io resolves to a.b.c.d). It answers
# DNS only; traffic goes straight to the CT. Certificates come from the dev CA.
# Agent tunnel endpoint: sandboxes use public DNS and are not on the tailnet, so the LAN address.
TUNNEL_HOST="${UMIAK_DEVCP_TUNNEL_HOST:-tunnel.${CT_IP//./-}.sslip.io}"
TUNNEL_URL="wss://$TUNNEL_HOST/v1/connect"
# Port previews need a wildcard, which MagicDNS and Serve cannot give: *.umiak.<tailnet address>,
# served by the gateway on 443 of the tailnet address.
PORT_DOMAIN="${UMIAK_DEVCP_PORT_DOMAIN:-umiak.${CT_TAILNET_IP//./-}.sslip.io}"

# The dev CA (outside git) and its copy on the CT, both 0600.
CA_DIR="${UMIAK_DEVCP_CA_DIR:-${UMIAK_CONFIG_DIR:-$HOME/.config/umiak}/dev-ca}"

# Child of the constrained CA's tunnel name, resolving to the same LAN address.
TURN_HOST="${UMIAK_DEVCP_TURN_HOST:-turn.$TUNNEL_HOST}"
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_RELAY_MIN=61000
TURN_RELAY_MAX=61040

# Local HTTP deployment preserves gateway names and certificates.
AUTH_MODE="${UMIAK_DEVCP_AUTH_MODE:-oidc}"
case "$AUTH_MODE" in
 none)
  APP_ORIGIN="http://$CT_IP:4180"
  API_URL="http://$CT_IP:8080"
  MCP_URL="$APP_ORIGIN/mcp"
  SERVE=""
  ;;
 oidc) ;;
 *) echo "UMIAK_DEVCP_AUTH_MODE must be oidc or none" >&2; return 1 ;;
esac
