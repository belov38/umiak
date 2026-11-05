> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S16 follow-up security rulings

## Ingress boundary

The public 4180 server ignores all forwarded headers, including connections from
loopback and Docker NAT peers and even if proxy-chain CIDRs are configured. A
second server on container port 4181 shares the owner store and setup handler.
Compose publishes it only as `127.0.0.1:4181:4181`. Host-run Serve/Caddy/nginx must
use that listener; it is an explicit trusted origin boundary. Do not publish it
on a LAN/tailnet wildcard. Docker internal peers with access to that port are
part of the deployment trust boundary. No Docker NAT/gateway address is trusted.
The optional Tailscale sidecar retains its isolated network and now targets 4181.
`UMIAK_TRUSTED_PROXY_CIDRS` only controls additional trusted hops inside XFF chains;
it cannot enable forwarding on 4180. The first untrusted client from the right is
used for rate limits and S15 denied CIDRs. Origin/Host checks, owner credentials,
claim capabilities, browser and CLI session records are unchanged.

## Host preparation transport and integrity

For non-loopback HTTP the command panel explicitly warns that root script
execution and the callback's API token secret, CA and host key use unencrypted
HTTP, and recommends Serve/HTTPS. Ruling: replace piping curl into bash with a
downloaded script, display its SHA256, verify it with `sha256sum -c` before both
dry-run and execution. This pins the exact script shown by the authenticated UI;
it does not authenticate an HTTP-delivered page or protect the callback. HTTPS
remains the recommendation. The hash covers the exact rendered capability-bound
script and the endpoint regenerates it using the same parameters.

## Media

VirtIO uses the immutable 0.1.271 archive filename matching the existing SHA256,
rather than the moving stable alias. PVE download auditing reads `http_proxy`
from `/cluster/options` and exempts only wget resolution/connection records for
that configured transport endpoint. All redirect URLs and all other resolved or
connected targets remain subject to the original HTTPS/private-address checks.
Failure to read cluster options fails closed before starting a download. PVE
silently hides `http_proxy` without `Sys.Audit` on `/`, so URL download preflight
requires that effective privilege explicitly. Fresh preparation grants a dedicated
`UmiakDatacenterAudit` role with only `Sys.Audit`, on `/` with propagation disabled,
to both the user and privsep token. Existing/adopted hosts are unchanged; missing
read access gives an actionable error before a download starts. Uploaded media
does not require this extra privilege.

## Verification

Focused regression tests cover NAT/loopback spoofing, public cookie selection,
client address, proxy origin/secure cookies, denied forwarded clients, unchanged
owner/CLI bearer sessions, isolated sidecar configuration, preparation warning,
command integrity hash and proxy-log exemptions with malicious redirects/targets.
Final aggregate gates and live evidence are recorded in the S16 implementation plan.

## Canonical upstream Host

Removing the stale API Host allowance exposed internal metadata and MCP requests
that used Docker DNS `api:8080` as their Host. Ruling: keep the API Host guard and
public API URL unchanged. The metadata bridge and local MCP transport connect to
the fixed internal API URL but set Host to the configured canonical
`UMIAK_API_URL` authority, independently of incoming headers. The root Compose
metadata bridge explicitly receives that URL. OIDC behavior remains unchanged.
Regression tests cover metadata bridging with a malicious inbound Host and MCP
initialization against the real local API Host guard, with no extra Host allowance.

### Node 26 wire transport correction

A real CT590 metadata request exposed that Node 26 fetch rewrites Host to the URL
host even when the caller sets a Host header. The earlier mocked/Hono tests did
not exercise that wire behavior. The canonical authority now uses a shared
native `node:http`/`node:https` fetch-compatible transport, with explicit Host,
request bodies, streamed responses, cancellation and no redirect following.
Quickstart metadata, the metadata bridge and local MCP all use that transport.
Real socket regressions cover quickstart/metadata bridge and MCP initialization;
the helper also verifies POST body and aborted requests. Docker mounts/copies
include the helper for both quickstart and legacy metadata bridge deployments.
