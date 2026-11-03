# Getting started

Umiak gives you throwaway Proxmox virtual machines for code, tools and AI agents.
Open **Getting started** in the dashboard sidebar at `/app/getting-started` for this deployment’s real URLs and copy buttons. `/app/help` redirects there.

The examples below use `https://api.example.com`, `https://app.example.com` and `preview.example.com`. Replace them with the URLs shown in your dashboard. Commands are checked against the in-app guide by `apps/web/test/getting-started.test.ts`.

Quickstart: run `docker compose up -d --build` from the repository root, then follow [the operator quickstart](../deploy/compose/quickstart/README.md).

## The model in one minute

A sandbox is a throwaway virtual machine, identified by a three-word slug. A template is the image it is cloned from; a size sets RAM and vCPU. Your team owns its sandboxes, snapshots and API keys.

Snapshots save a disk so you can create another sandbox with --from. Fork copies a sandbox directly. Port previews expose a guest port over HTTPS. Desktop templates stream a screen that people and agents can control.

Inactive sandboxes stop automatically according to deployment policy. Their disks remain available for resume. Use limits to check the actual quotas before creating a sandbox.

## Install the CLI (owner · private CA)

This deployment serves the CLI installer. First obtain umiak-ca.pem through the operator's Docker console and compare its SHA-256 fingerprint through that trusted channel. Trust the owner CA in your browser too. Never download and trust a CA only through an unverified connection.

**Retrieve owner CA (on the Docker host)**

```text
docker compose cp quickstart:/var/lib/umiak/owner/tls/ca.pem ./umiak-ca.pem
```

**Check owner CA fingerprint**

```text
openssl x509 -in umiak-ca.pem -noout -fingerprint -sha256
```

**Install with verified CA**

```text
curl --fail --cacert ./umiak-ca.pem 'https://api.example.com/install.sh' -o umiak-install.sh && UMIAK_CA_CERT="$PWD/umiak-ca.pem" sh ./umiak-install.sh
```

The installer runs login. Open the pairing link on the hostname where you claimed this deployment, and compare the short code shown in your terminal before approving. The CLI saves the CA in its profile.

**Check CLI profile**

```text
umiak whoami
```

## Your first sandbox

Create a Linux sandbox, copy the printed slug into current, then run a command. The dashboard's New sandbox button and Terminal tab offer the same flow.

**Create a sandbox**

```text
umiak create --template linux --wait
```

**Select your sandbox**

```text
umiak current <slug>
```

**Run a command**

```text
umiak exec -- uname -a
```

**Open a shell**

```text
umiak shell
```

**Run in a temporary sandbox**

```text
umiak run -- uname -a
```

**Copy files**

```text
umiak cp ./notes.txt <slug>:notes.txt
umiak push . <slug>:app
```

**Stop and resume**

```text
umiak stop --wait
umiak resume --wait
```

**Delete your sandbox**

```text
umiak rm <slug> --yes
```

Replace <slug> with your sandbox's name. Run creates a temporary sandbox, runs a command and deletes it. Delete resources you no longer need.

## Port previews

A preview URL has the form https://<slug>-<port>.preview.example.com. Start a server inside the VM, then publish its port. Token access is the default; public access lets anyone with the URL connect.

**Start a preview server**

```text
umiak exec --detach -- python3 -m http.server 3000
```

**Publish a protected port**

```text
umiak port 3000
```

**Publish a public port**

```text
umiak port 3000 --public
```

Preview TLS uses the guest gateway certificate, which may have a different CA from the owner dashboard. Ask the operator for its verified CA if your browser does not trust it.

## Desktops

Use an available desktop template for a graphical session. Desktop templates need more RAM than a headless Linux sandbox. The dashboard's Desktop tab has the same viewer.

**Create a desktop**

```text
umiak create --template linux-desktop --wait
```

**Open the viewer**

```text
umiak desktop open <slug>
```

**Take a screenshot**

```text
umiak desktop screenshot <slug> -o screen.png
```

**Control the desktop**

```text
umiak desktop act <slug> click 400 300
umiak desktop act <slug> type "hello"
```

## Connect an agent with MCP (owner · private CA)

The recommended stdio transport uses your CLI profile, including pairing and CA settings. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

**Claude Code · stdio**

```text
claude mcp add --transport stdio --scope user umiak -- umiak mcp
```

**Codex · ~/.codex/config.toml**

```text
[mcp_servers.umiak]
command = "umiak"
args = ["mcp"]
```

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Remote clients must also trust the deployment CA.

**Claude Code · remote HTTP**

```text
{
  "mcpServers": {
    "umiak-remote": {
      "type": "http",
      "url": "https://app.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${UMIAK_OWNER_TOKEN}"
      }
    }
  }
}
```

**Codex · remote HTTP configuration**

```text
[mcp_servers.umiak-remote]
url = "https://app.example.com/mcp"
bearer_token_env_var = "UMIAK_OWNER_TOKEN"
```

For Claude Code, save the remote JSON configuration in .mcp.json. Set UMIAK_OWNER_TOKEN in the client environment using your own paired CLI credential from its private profile; never commit a credential or paste it into this guide. Stdio avoids this manual credential transfer.

Ask your agent: "Create a Linux sandbox, clone my repository into it and run the tests." umiak mcp --help explains read-only mode, toolsets and sandbox restrictions.

## Use the SDK

Both SDKs read the API URL and credentials from your CLI profile after login. Run package installation from the repository checkout; these packages are available as source/workspace packages.

**Install Python SDK**

```text
pip install -e packages/sdk-py
```

**Python**

```text
from umiak_sdk import Umiak

with Umiak() as umiak:
    sb = umiak.sandboxes.create(template="linux", wait=True)
    try:
        print(sb.exec("uname -a").stdout)
    finally:
        sb.delete()
```

**TypeScript · @umiak/sdk workspace package**

```text
import { Umiak } from "@umiak/sdk";

const umiak = new Umiak();
const sb = await umiak.sandboxes.create({ template: "linux" }, { wait: true });
try {
    console.log((await sb.exec(["uname", "-a"])).stdout);
} finally {
    await sb.delete();
}
```

The API reference is available at https://api.example.com/v1/openapi.json. API keys can restrict automated clients to a team and scopes.

## Limits and cleanup

Limits belong to this deployment and team; check them rather than assuming a fixed VM count or memory budget. Stopping frees RAM while keeping the disk; deleting frees the sandbox resources.

**Check quotas**

```text
umiak limits
```

**List sandboxes**

```text
umiak ls
```

If quota_exceeded or out_of_capacity appears, stop or delete an unused sandbox, or ask the operator about capacity. Desktop templates need at least the size shown in New sandbox.

## Troubleshooting (owner · private CA)

Connection timeout: check the URL, LAN or tailnet reachability and deployment network policy. Local mode is only reachable from allowed networks. On macOS, check the browser's Local Network permission if curl works but the browser cannot connect.

Certificate error: obtain the CA through a trusted operator channel and compare the fingerprint. Owner and preview CAs are separate. Do not bypass certificate verification for an installer.

Pairing page asks to claim an already claimed deployment: open the pairing path on the hostname where you are signed in. Cookies are host-only. An expired pairing request needs a fresh login.

Template unavailable: use Setup → Templates to register detected templates or its Build Linux template button. Operators can also use the documented apps/template-builder path in the repository. A successful build must be registered before creation.

**Inspect CLI commands**

```text
umiak --help
umiak mcp --help
```

**Inspect stack logs (Docker host)**

```text
docker compose logs --tail=100 quickstart api worker gateway
```

## Optional Tailscale Serve

Operators can use Tailscale Serve for a publicly trusted dashboard certificate. Supply a Tailscale auth key through the environment; never commit it. This is an optional Docker Compose override.

**Start with Tailscale Serve**

```text
TS_AUTHKEY=... TS_HOSTNAME=umiak docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml up -d --build
```

Serve covers this dashboard hostname. It cannot serve wildcard preview hostnames: previews still use the guest gateway and its wildcard certificate and DNS configuration.

## Install the CLI (owner · publicly trusted HTTPS)

This deployment serves the CLI installer over publicly trusted HTTPS; no private owner CA is needed.

**Install CLI**

```text
curl --fail 'https://api.example.com/install.sh' -o umiak-install.sh && sh ./umiak-install.sh
```

The installer runs login. Open the pairing link on the hostname where you claimed this deployment, and compare the short code shown in your terminal before approving. The CLI saves the CA in its profile.

**Check CLI profile**

```text
umiak whoami
```

## Install the CLI (none)

Build the CLI from the repository checkout. Choose the output for your OS and CPU (darwin/linux, arm64/x64), or umiak-windows-x64.exe on Windows. Copy it to a directory on PATH; a shell alias is insufficient for agent clients.

**Build the CLI**

```text
mise exec -- pnpm install
mise exec -- pnpm --filter @umiak/cli build
```

**Install CLI (macOS arm64 example)**

```text
mkdir -p ~/.local/bin
cp apps/cli/dist/umiak-darwin-arm64 ~/.local/bin/umiak
export PATH="$HOME/.local/bin:$PATH"
```

**Log in to this deployment**

```text
umiak login --api-url 'https://api.example.com'
umiak whoami
```

No sign-in is required in local mode. Access is restricted by the deployment's network policy; never expose the local listener to an untrusted network.

## Connect an agent with MCP (none)

The recommended stdio transport uses your CLI profile, including pairing and CA settings. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

**Claude Code · stdio**

```text
claude mcp add --transport stdio --scope user umiak -- umiak mcp
```

**Codex · ~/.codex/config.toml**

```text
[mcp_servers.umiak]
command = "umiak"
args = ["mcp"]
```

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Remote clients must also trust the deployment CA.

**Claude Code · remote HTTP**

```text
claude mcp add --transport http --scope user umiak-remote 'https://app.example.com/mcp'
```

**Codex · remote HTTP configuration**

```text
[mcp_servers.umiak-remote]
url = "https://app.example.com/mcp"
```

Ask your agent: "Create a Linux sandbox, clone my repository into it and run the tests." umiak mcp --help explains read-only mode, toolsets and sandbox restrictions.

## Troubleshooting (none)

Connection timeout: check the URL, LAN or tailnet reachability and deployment network policy. Local mode is only reachable from allowed networks. On macOS, check the browser's Local Network permission if curl works but the browser cannot connect.

Certificate error: obtain the CA through a trusted operator channel and compare the fingerprint. Owner and preview CAs are separate. Do not bypass certificate verification for an installer.

Template unavailable: ask the operator to register a template build in Admin. Template builders live in apps/template-builder in the repository.

**Inspect CLI commands**

```text
umiak --help
umiak mcp --help
```

**Inspect stack logs (Docker host)**

```text
docker compose logs --tail=100 api worker gateway
```

## Install the CLI (oidc)

Build the CLI from the repository checkout. Choose the output for your OS and CPU (darwin/linux, arm64/x64), or umiak-windows-x64.exe on Windows. Copy it to a directory on PATH; a shell alias is insufficient for agent clients.

**Build the CLI**

```text
mise exec -- pnpm install
mise exec -- pnpm --filter @umiak/cli build
```

**Install CLI (macOS arm64 example)**

```text
mkdir -p ~/.local/bin
cp apps/cli/dist/umiak-darwin-arm64 ~/.local/bin/umiak
export PATH="$HOME/.local/bin:$PATH"
```

**Log in to this deployment**

```text
umiak login --api-url 'https://api.example.com'
umiak whoami
```

Login opens browser sign-in through this deployment's identity provider. For unattended clients, use a scoped team API key from API keys.

## Connect an agent with MCP (oidc)

The recommended stdio transport uses your CLI profile, including pairing and CA settings. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

**Claude Code · stdio**

```text
claude mcp add --transport stdio --scope user umiak -- umiak mcp
```

**Codex · ~/.codex/config.toml**

```text
[mcp_servers.umiak]
command = "umiak"
args = ["mcp"]
```

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Remote clients must also trust the deployment CA.

**Claude Code · remote OAuth**

```text
claude mcp add --transport http --scope user --client-id umiak-mcp --callback-port 33418 umiak-remote 'https://app.example.com/mcp'
claude mcp login umiak-remote
```

**Codex · remote OAuth**

```text
codex mcp add umiak-remote --url 'https://app.example.com/mcp' --oauth-client-id umiak-mcp
codex mcp login umiak-remote
```

**Codex · OAuth callback setting**

```text
[mcp_servers.umiak-remote.oauth]
client_id = "umiak-mcp"
callback_port = 33418
```

Ask your agent: "Create a Linux sandbox, clone my repository into it and run the tests." umiak mcp --help explains read-only mode, toolsets and sandbox restrictions.
