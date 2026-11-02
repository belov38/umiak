# Zero-config self-host quickstart (S16)

From the repository root:

```sh
docker compose up -d --build
docker compose logs quickstart
docker compose cp quickstart:/var/lib/umiak/owner/tls/ca.pem ./umiak-ca.pem
openssl x509 -in umiak-ca.pem -noout -fingerprint -sha256
```

Use the local Docker console as the trust channel. Install this verified CA in your
browser trust store, then open `https://localhost:8444` on the Docker host, or
`https://<docker-host-DNS-name>:8444` remotely. DNS can be LAN DNS, mDNS, MagicDNS or
ordinary DNS; Tailscale is optional. No external relay is used.

Enter the one-time setup code from the logs to claim ownership. Other LAN/tailnet
peers cannot operate the deployment. Owner cookies expire after 180 days; CLI pairing
requests expire after five minutes. Credentials and claim state survive container recreation.

For raw LAN/tailnet IP URLs, first open by localhost or a DNS name and visit
`/owner/tls` to add the IPs to the certificate. This takes effect immediately and is
persisted without an `.env` file. Certificates for DNS names are issued on demand.
The guest gateway on port 443 uses its own independent CA.

## Wizard

Open `/setup`. Each step records status and errors in Postgres and can be retried.

1. Enter the Proxmox HTTPS origin, node name and SHA256 leaf certificate fingerprint
   verified at the Proxmox console. Existing token/key/root CA can be mounted into
   `pve-secrets`; otherwise use host preparation to provision them. Fingerprint
   checking protects discovery; the worker uses the actual Proxmox root CA.
2. Adopt an existing host, or generate a preparation command. With least-privilege
   API tokens, generate the read-only adoption report command, copy the verified
   owner CA to the PVE host and run it as root. This reports existing user/token,
   pool, SDN, IPSet/rules and node-agent without changing host objects. Host script
   URLs are expiring, single-use capabilities; keep them private. Inspect `--dry-run`
   first. Fresh preparation fails closed if shared host networking/firewall
   prerequisites are missing; it does not silently enable global policy.
3. Choose lvmthin storage, sandbox VMID range within 500–589 and RAM cap up to 8192 MiB.
4. Set the guest-reachable gateway address, tunnel URL and preview domain. IPv4
   defaults use sslip.io for DNS only. Apply changed gateway/worker settings with
   `docker compose up -d --force-recreate gateway-secrets` followed by
   `docker compose restart gateway worker api web`. Do not reissue the CA trusted by
   existing templates. On the prepared dev stand preserve its explicit tunnel URL.
5. Register existing template builds, or build Linux in an empty template slot.
   Optional desktop/Windows recipes require their ISO/media prerequisites. Occupied
   templates are never rebuilt by the wizard. Build status is durable; after an
   interrupted server restart retry a failed job.
6. Run the smoke test: one 2 GiB Linux sandbox, exec, deletion. Setup is complete only
   after every step succeeds. Running sandbox RAM is checked before creating a VM.

Help is at `/app/help` with this deployment's actual CLI, MCP and SDK URLs and copy
buttons. The dashboard sidebar links Help and Setup.

## Install and pair the CLI

With the verified CA saved as `~/.config/umiak/quickstart-ca.pem`:

```sh
curl --cacert ~/.config/umiak/quickstart-ca.pem -fsSL https://HOST:8444/install.sh |
  UMIAK_CA_CERT="$HOME/.config/umiak/quickstart-ca.pem" sh
```

For a publicly trusted certificate the command is simply
`curl -fsSL https://HOST:8444/install.sh | sh`. The installer detects Darwin/Linux
arm64/x64, verifies SHA256SUMS, installs to `~/.local/bin` (`UMIAK_INSTALL_DIR` overrides
it) and starts `umiak login`. Open its pairing URL in the claimed browser, compare
the request identifier and approve. Never approve a request you did not start.

```sh
umiak create --template linux --size 2gb --wait
umiak exec <slug> -- uname -a
umiak rm <slug> --yes
```

CLI profiles retain the CA path. `umiak logout` revokes that CLI's owner credential.
Windows x64 CLI is available under `/downloads/umiak-windows-x64.exe`; the shell
installer supports Darwin and Linux.

## Console recovery and legacy modes

If the owner browser is lost, a trusted Docker operator can invalidate all owner
sessions and CLI pairings and print a new one-time claim code:

```sh
docker compose exec quickstart node deploy/compose/quickstart/run.mjs node deploy/compose/quickstart/recover.mjs
```

This changes only owner access; setup, VM data and guest trust are preserved. The
recovery command is deliberately unavailable over HTTP.

Legacy OIDC: `docker compose -f deploy/compose/compose.yaml up -d --build`.
Legacy S15: add `-f deploy/compose/local.yaml`. Do not run two stacks over the same
DB simultaneously. Protect and back up named volumes; `down -v` deletes state.

CT590 deployment: `infra/dev-cp/deploy-quickstart.sh`; rollback:
`UMIAK_DEVCP_AUTH_MODE=none infra/dev-cp/deploy.sh` (or `oidc`). No PVE objects,
gateway CA or guest port are replaced by that quickstart deployment.
