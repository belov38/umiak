# Gateway deployment

The gateway is a service of the root Compose stack, installed into the control
plane LXC. The quickstart offline bootstrap creates its certificates, SSH keys
and service tokens and gives each consumer only the secrets it needs.

The gateway serves agent tunnels, HTTP previews, SSH and desktop WebSocket
traffic. Desktop streaming stays on the agent tunnel. Access is limited by the
installer's tailnet networking and firewall configuration.

For local development use `compose.yaml` with `compose.dev.yaml` from the root.
See [architecture](../../docs/architecture.md) for routing and authentication.
