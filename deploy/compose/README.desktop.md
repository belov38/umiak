# Desktop transport

Desktop streaming runs over WebSocket through the owner ingress, gateway and
outbound guest-agent tunnel. No relay server, relay credentials, extra media
address or published media ports are required. The worker always sends an empty
ICE server list when configuring a desktop.

See [architecture](../../docs/architecture.md) and the root Compose stack.
