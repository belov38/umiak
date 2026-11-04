# Umiak

Disposable VMs for AI agents, running on Proxmox VE. Create a sandbox from the CLI, API or MCP, run commands in it, open its ports as preview URLs, SSH in or use its desktop.

Templates: `linux`, `linux-desktop`, `windows` (Windows 11, bring your own ISO).

## Install

You need:

- Proxmox VE 9 and a root shell on a node
- a Tailscale account with MagicDNS and HTTPS enabled

On the Proxmox node:

```sh
curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh
```

The installer creates a Proxmox user, network and pool for Umiak, starts the control plane in a container and adds it to your tailnet. At the end it prints a link; open it on any device in your tailnet. Run the same command again to update, sign in from another browser or uninstall.

Then:

```sh
umiak create --template linux --wait
umiak exec <name> -- uname -a
```

Full guide: [docs/getting-started.md](docs/getting-started.md).

## Development

```sh
docker compose --env-file compose.dev.env -f compose.yaml -f compose.dev.yaml up --build
```

[Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md) · [Specs](docs/specs/) · [Corporate deployment (OIDC)](deploy/compose/README.md)

Apache-2.0
