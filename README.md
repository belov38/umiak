# Umiak

Self-hosted platform of API-driven VM sandboxes for AI agents on Proxmox VE (a boat.dev alternative). Guest templates: Linux (`linux`), Linux with desktop (`linux-desktop`), Windows 11 with desktop (`windows`). Windows Server Core is planned.

- Getting started: [docs/getting-started.md](docs/getting-started.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Scopes and status: [docs/roadmap.md](docs/roadmap.md)
- Specs: `docs/specs/`

## Install on Proxmox (homelab)

Prerequisites: Proxmox VE 9.x serving its default certificate on port 8006 (a custom or ACME `pveproxy-ssl.pem` is not supported yet), a root shell on the node, a free static LAN IPv4 address for the control plane container, and a Tailscale account with MagicDNS and HTTPS certificates enabled. Tailscale runs inside the control plane container, not on the PVE host. After the install, disable key expiry for the `umiak` machine in the Tailscale admin console.

```sh
curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh
```

The installer verifies the release bundle, creates the Umiak objects in Proxmox (user and token, roles, pool, SDN zone and VNet, IPSet, restricted node-agent), an unprivileged Debian 13 LXC with Docker and Tailscale, pulls the images from GHCR and prints `https://umiak.<tailnet>.ts.net/claim#<code>`. Access is tailnet HTTPS only. Re-run the same command later for Update, Sign in a new browser, Reset owner access or Uninstall. Details: [docs/getting-started.md](docs/getting-started.md).

Contributors build the stack from this checkout:

```sh
docker compose --env-file compose.dev.env -f compose.yaml -f compose.dev.yaml up --build
```

The corporate OIDC deployment (Keycloak, oauth2-proxy) lives in [deploy/compose/README.md](deploy/compose/README.md).

## Windows template

Windows 11 uses the single `windows` template and includes the desktop (4gb by default; 8gb optional). Linux offers `linux` and `linux-desktop`. The legacy `windows-desktop` slug remains an input alias of `windows`; API responses return `windows`. Existing headless Windows sandboxes and saved snapshots retain their retired build until deleted.
