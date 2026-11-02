# Getting started

For the zero-config S16 path, run `docker compose up -d --build` from the repository
root and follow [the quickstart guide](../deploy/compose/quickstart/README.md).
It uses an owner claim and CLI pairing, with dashboard help at `/app/help`.
The S15 addresses and tokenless instructions below describe the previous deployment
mode; use them only after explicitly rolling the stand back to S15.

Umiak gives you throwaway virtual machines (sandboxes) on Proxmox that you drive from a dashboard, a CLI, an SDK or an AI agent over MCP. This guide walks you through the dev stand from zero to a sandbox your agent can use.

## The model in one minute

| Term | What it is |
|---|---|
| Sandbox | One VM. It gets a slug of three random words (`mint-clay-bell`), which every command takes. |
| Template | The image a sandbox is cloned from: `linux`, `linux-desktop`, `windows`, `windows-desktop`. |
| Size | RAM and vCPU: `2gb` (2 vCPU), `4gb` (4 vCPU), `8gb` (8 vCPU). `linux` is 2gb only; the other templates take 4gb or 8gb. |
| Team | Owner of sandboxes, snapshots and API keys. In local mode you are the only user, with your own team. |
| Snapshot | A saved disk you can create new sandboxes from (`--from`). `fork` copies a sandbox directly. |
| Port preview | An HTTPS URL for a port inside the sandbox, with `token` or `public` access. |
| Desktop | The screen of a `*-desktop` sandbox, streamed to the browser; agents can take screenshots and click and type. |

A sandbox stops by itself after 15 minutes without activity (its disk is kept) and comes back with `resume`. The dev stand allows 3 running sandboxes and 8 GB of sandbox RAM in total.

## 1. Check you can reach the stand

The dev stand runs in container CT 590 on `pve` in local mode: no login, but **only from the home LAN `192.168.68.0/24`**. From another network (office, phone hotspot, Tailscale only) the addresses below time out.

| What | Address |
|---|---|
| Dashboard | http://192.168.68.90:4180/app |
| API (CLI, SDK) | http://192.168.68.90:8080 |
| MCP over HTTP | http://192.168.68.90:4180/mcp |
| Port previews | `https://<slug>-<port>.umiak.100-64-10-7.sslip.io` |

```sh
curl http://192.168.68.90:8080/v1/meta     # {"authMode":"none",...}
```

If curl answers but Chrome shows `ERR_ADDRESS_UNREACHABLE`, macOS is blocking Chrome from the local network: quit Chrome fully (Cmd+Q) and start it again, or toggle Chrome off and on in System Settings → Privacy & Security → Local Network. If curl times out too, check that the Mac is on the home Wi-Fi.

## 2. Look around in the dashboard

Open http://192.168.68.90:4180/app.

1. **New sandbox** → template `linux` → Create. It is ready in about 15 seconds.
2. On the sandbox page, the **Terminal** tab gives you a shell in the VM.
3. **Ports** publishes a port, **Files** uploads and downloads, **Stop / Resume / Fork / Delete** are in the header.
4. Delete it when you are done.

`/admin` is the operator panel: templates, sizes, quotas, teams. You don't need it to start.

## 3. Install the CLI

The CLI is not published yet; build it from this checkout:

```sh
mise exec -- pnpm install
mise exec -- pnpm --filter @umiak/cli build
alias umiak="$PWD/apps/cli/dist/umiak-darwin-arm64"   # put it in ~/.zshrc or on PATH
umiak login --api-url http://192.168.68.90:8080
umiak whoami
```

Previews use certificates from the dev CA. Trust it once so the browser opens them:

```sh
infra/dev-cp/trust-mac.sh          # asks for the macOS password; --remove undoes it
```

## 4. Your first sandbox from the CLI

```sh
umiak create --wait                          # linux, 2gb; prints the slug
umiak current <slug>                         # later commands may omit the slug
umiak exec -- uname -a
umiak shell                                  # interactive terminal
umiak cp ./notes.txt <slug>:notes.txt        # and back: umiak cp <slug>:notes.txt .
umiak push . <slug>:app                      # upload a git repository (tracked files)

umiak exec --detach -- python3 -m http.server 3000
umiak port 3000                              # prints a URL with ?_token=...
umiak port 3000 --public                     # no token

umiak stop --wait                            # disk kept, RAM freed
umiak resume --wait
umiak rm <slug> --yes
```

`umiak run -- <cmd>` creates a sandbox, runs one command and deletes it. `umiak ls` lists your sandboxes; `umiak limits` shows what you can still create. Every command has `--help`.

## 5. Desktops

```sh
umiak create --template linux-desktop --wait     # 4gb; windows-desktop takes a few minutes
umiak desktop open <slug>                        # opens the viewer in the browser
umiak desktop screenshot <slug> -o screen.png
umiak desktop act <slug> click 400 300
umiak desktop act <slug> type "hello"
```

The dashboard has the same viewer on the sandbox page, **Desktop** tab. A desktop takes 4 GB of the 8 GB budget, so delete it when you finish.

## 6. Give it to an AI agent (MCP)

The CLI contains an MCP server with tools for sandboxes, commands, files, ports, snapshots and desktop control. It uses your `umiak login`.

Claude Code:

```sh
claude mcp add --transport stdio --scope user umiak -- umiak mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.umiak]
command = "umiak"
args = ["mcp"]
```

Here `umiak` must be on `PATH`, not just a shell alias. Then ask the agent something like "create a linux sandbox, clone https://github.com/... into it and run the tests". Options such as `--read-only`, `--toolsets` and `--sandbox <slug>` are in [apps/mcp/README.md](../apps/mcp/README.md). Clients that speak MCP over HTTP can use http://192.168.68.90:4180/mcp directly.

## 7. Use it from code (SDK)

Both SDKs read the API URL and credentials from your CLI profile, so after `umiak login` they need no arguments.

Python (`pip install -e packages/sdk-py`):

```python
from umiak_sdk import Umiak

with Umiak() as umiak:
    sb = umiak.sandboxes.create(template="linux", wait=True)
    try:
        r = sb.exec("uname -a")
        print(r.stdout)
        sb.files.write_text("hello.txt", "hi\n")
        print(sb.ports.host(8000, access="public").url)
    finally:
        sb.delete()
```

TypeScript (`@umiak/sdk`, workspace package):

```ts
import { Umiak } from "@umiak/sdk";

const umiak = new Umiak();
const sb = await umiak.sandboxes.create({ template: "linux" }, { wait: true });
try {
	const r = await sb.exec(["uname", "-a"]);
	console.log(r.stdout);
} finally {
	await sb.delete();
}
```

The API reference is the OpenAPI document of the api (`GET /v1/openapi.json`). In local mode the interactive `/v1/docs` page is turned off.

## When something goes wrong

- **Timeouts to `192.168.68.90`**: you are not on the home LAN; see step 1.
- **Preview certificate error**: run `infra/dev-cp/trust-mac.sh`, or `curl --cacert ~/.config/umiak/dev-ca/ca.pem <url>`.
- **`quota_exceeded` or `out_of_capacity`**: too many sandboxes are running. `umiak ls`, then `stop` or `rm --yes` some.
- **Check the whole stand**: `UMIAK_DEVCP_AUTH_MODE=none mise exec -- bash infra/dev-cp/e2e.sh` (about 4 minutes, cleans up after itself).
- **Logs**: `ssh umiak@192.168.68.90`, then `cd ~/umiak/deploy/compose && docker compose logs -f api worker gateway`.

## Where to go next

- Dev stand details, deploy and rollback to Keycloak login: [infra/dev-cp/QUICKSTART.md](../infra/dev-cp/QUICKSTART.md), [infra/dev-cp/README.md](../infra/dev-cp/README.md).
- Running Umiak on your own Proxmox at home: [deploy/compose/README.local.ru.md](../deploy/compose/README.local.ru.md).
- How it works: [architecture.md](architecture.md). Status and plans: [roadmap.md](roadmap.md).
