# Getting started

Umiak gives you throwaway Proxmox virtual machines for code, tools and AI agents.
Open **Getting started** in the dashboard sidebar at `/app/getting-started` for this deployment’s real URLs and copy buttons. `/app/help` redirects there.

Quickstart owner and local deployments show a single-owner dashboard without teams. OIDC deployments retain teams. Both the CLI and dashboard use the explicit `/v1/meta` tenancy field; older deployments without it retain team support.

The examples below use `https://api.example.com`, `https://app.example.com` and `preview.example.com`. Replace them with the URLs shown in your dashboard. Commands are checked against the in-app guide by `apps/web/test/getting-started.test.ts`.

Quickstart: run `docker compose up -d --build` from the repository root, then follow [the operator quickstart](../deploy/compose/quickstart/README.md).

## The model in one minute (owner)

A sandbox is a throwaway virtual machine, identified by a three-word slug. A template is the image it is cloned from; a size sets RAM and vCPU. You own your sandboxes, snapshots and API keys.

Snapshots save a disk so you can create another sandbox with --from. Fork copies a sandbox directly. Port previews expose a guest port over HTTP or HTTPS. Desktop templates stream a screen that people and agents can control.

Inactive sandboxes stop automatically according to deployment policy. Their disks remain available for resume. Use limits to check the actual quotas before creating a sandbox.

## Install the CLI (owner)

Quickstart uses HTTP on your trusted LAN by default (`http://HOST:4180`). For remote access and browser secure contexts, use Tailscale Serve (recommended) or your own HTTPS reverse proxy. Replace the example HTTPS origin below with your deployment's origin. No owner CA is generated.

**Install CLI**

```text
curl --fail 'https://api.example.com/install.sh' -o umiak-install.sh && sh ./umiak-install.sh
```

The installer runs login. Open the pairing link on the hostname where you claimed this deployment, and compare the short code shown in your terminal before approving. The CLI saves the deployment connection settings in its profile.

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

In a configured HTTPS deployment, a preview URL has the form https://<slug>-<port>.preview.example.com. Start a server inside the VM, then publish its port. Token access is the default; public access lets anyone with the URL connect.

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

Quickstart previews default to `http://<slug>-<port>.<gateway-IP>.sslip.io:8085`. The exact scheme, domain and port come from deployment metadata. Token access is still the default; `--public` allows anyone who can reach the preview. Serve cannot cover wildcard preview hostnames. Configured HTTPS previews use the guest gateway certificate; ask the operator for its verified CA if needed.

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

## Connect an agent with MCP (owner)

The recommended stdio transport uses your paired CLI profile. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

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

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Clients using your own HTTPS proxy must trust its certificate.

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

## Use the SDK (owner)

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

The API reference is available at https://api.example.com/v1/openapi.json. API keys restrict automated clients to the scopes you choose.

## Limits and cleanup (owner)

Limits belong to this deployment; check them rather than assuming a fixed VM count or memory budget. Stopping frees RAM while keeping the disk; deleting frees the sandbox resources.

**Check quotas**

```text
umiak limits
```

**List sandboxes**

```text
umiak ls
```

If quota_exceeded or out_of_capacity appears, stop or delete an unused sandbox, or ask the operator about capacity. Desktop templates need at least the size shown in New sandbox.

## Troubleshooting (owner)

Connection timeout: check the URL, LAN or tailnet reachability and deployment network policy. Local mode is only reachable from allowed networks. On macOS, check the browser's Local Network permission if curl works but the browser cannot connect.

Certificate error: check the certificate configured on your own HTTPS proxy or guest gateway. Obtain any required CA through a trusted operator channel and compare its fingerprint. Do not bypass certificate verification for an installer.

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

Quickstart defaults to LAN HTTP on port 4180. Tailscale Serve is recommended for private remote access and browser secure contexts. Operators may use their own HTTPS reverse proxy instead. If you use Funnel, this is public; an Internet-facing proxy also exposes the deployment publicly. Owner authentication remains required. Supply a Tailscale auth key through the environment; never commit it. This is an optional Docker Compose override.

**Start with Tailscale Serve**

```text
TS_AUTHKEY=... TS_HOSTNAME=umiak docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml up -d --build
```

Serve covers this dashboard hostname. It cannot serve wildcard preview hostnames: quickstart previews still use the guest gateway HTTP listener on port 8085 and IP-derived sslip.io DNS by default. Setup and Settings show the Funnel public-exposure warning on a `.ts.net` origin. See the operator quickstart for trusted proxy headers and host configuration.

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

The recommended stdio transport uses your paired CLI profile. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

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

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Clients using your own HTTPS proxy must trust its certificate.

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

Certificate error: check the certificate configured on your own HTTPS proxy or guest gateway. Obtain any required CA through a trusted operator channel and compare its fingerprint. Do not bypass certificate verification for an installer.

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

## The model in one minute (oidc)

A sandbox is a throwaway virtual machine, identified by a three-word slug. A template is the image it is cloned from; a size sets RAM and vCPU. Your team owns its sandboxes, snapshots and API keys.

Snapshots save a disk so you can create another sandbox with --from. Fork copies a sandbox directly. Port previews expose a guest port over HTTP or HTTPS. Desktop templates stream a screen that people and agents can control.

Inactive sandboxes stop automatically according to deployment policy. Their disks remain available for resume. Use limits to check the actual quotas before creating a sandbox.

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

The recommended stdio transport uses your paired CLI profile. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.

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

Remote MCP is available at https://app.example.com/mcp. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. Clients using your own HTTPS proxy must trust its certificate.

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

## Use the SDK (oidc)

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

## Limits and cleanup (oidc)

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


## LAN install and private proxy CAs

For a default LAN deployment:

```sh
curl --fail http://HOST:4180/install.sh -o umiak-install.sh && sh ./umiak-install.sh
```

Generic `--cacert` support is available when your own HTTPS proxy uses a private
CA. Verify that CA through a trusted operator channel, then use:

```sh
curl --fail --cacert ./proxy-ca.pem https://your-proxy/install.sh -o umiak-install.sh
UMIAK_CA_CERT="$PWD/proxy-ca.pem" sh ./umiak-install.sh
umiak login --api-url https://your-proxy --cacert ./proxy-ca.pem
```

Quickstart does not generate an owner CA. Publicly trusted Serve/proxy certificates
and LAN HTTP need no private CA file.

## Secure browser features

The desktop viewer follows the preview scheme and port (HTTP8085 in quickstart).
Its WebSocket video decoder needs WebCodecs `VideoDecoder`, unavailable on LAN
HTTP. Serve secures the dashboard, not separate wildcard HTTP viewers. An HTTPS
parent cannot embed an HTTP viewer; use **Open in new tab** for HTTP experiments,
and set any Chrome test override for that exact viewer origin too. A viewer HTTPS
proxy resolves that transport restriction; an HTTPS viewer under an HTTP parent
must be opened in a new tab to avoid the insecure ancestor.

In Chromium, `RTCPeerConnection` exists on LAN HTTP, while `VideoDecoder`,
`VideoEncoder`, Clipboard API, `navigator.mediaDevices` and `crypto.subtle` do not.
WebRTC constructor availability is not a full desktop streaming test. Desktop does
not capture the browser camera/microphone; no dashboard getUserMedia or
crypto.subtle usage was found. Clipboard falls back to execCommand, then manual
selection. Dashboard and same-origin WebSocket terminal otherwise work over HTTP.

For features requiring a secure browser context:

1. Use Tailscale Serve (recommended).
2. Use localhost: for a remote Docker host, run
   `ssh -L 4180:localhost:4180 <docker-host>` and open `http://localhost:4180`.
3. Use your own HTTPS reverse proxy with a trusted certificate.
4. For a quick Chrome test only, add the exact deployment origin at
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and relaunch Chrome.
   This weakens browser protection; remove the exception after the test. It does
   not establish certificate trust.

## Guest certificate lifecycle

The guest tunnel keeps TLS and its existing CA. New guest CAs last ten years;
existing CAs retain their expiry. Gateway leaf certificates are checked daily and
renewed with the same CA when 30 days or less remain, without restarting the
gateway. Leaf renewal keeps agent/template trust intact.

Setup and Settings show guest CA, tunnel and preview certificate expiry dates.
At one year or less before CA expiry, the warning explains that CA rotation
requires rebuilding agent packages and templates and migrating existing guests.
Plan rotation before expiry; the CA is never silently replaced or extended.
