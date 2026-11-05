# Homelab deployment

Umiak installs on a Proxmox VE node with `curl … install.sh | sh`. The installer
runs the root [`compose.yaml`](../../compose.yaml) stack in an LXC and exposes
it only through Tailscale. Authentication uses owner claim links, browser
sessions and CLI pairing. See [Getting started](../../docs/getting-started.md).

For local development, from the repository root:

```sh
docker compose --env-file compose.dev.env -f compose.yaml -f compose.dev.yaml up --build
```

The `quickstart/` directory contains the trusted owner ingress and installation
bootstrap. `config/` supplies the topology and identity data needed by that path.
The gateway, API, worker and MCP remain TypeScript/Go services. The API serves
the static Vite React dashboard; configuration uses the API migration journal
and `runtime` schema. There is no web server container or Payload secret/migrator.
See [S24](../../docs/specs/s24-spa-no-payload.md) for the incompatible upgrade
and required bridge updater `0.4.0-edge.20261105.5`.
Desktop streaming uses WebSocket through the gateway and agent tunnel.
