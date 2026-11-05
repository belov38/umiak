> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S16 final polish plan and rulings

The acceptance findings in the task define the design. Details are delegated to
this implementation; no start or design approval is required.

- [x] Add failing peer-origin fixtures, then require an independent fixed socket
  peer allowlist on the proxy listener. Preserve existing Compose networks (the
  task prohibits network changes). Document the Docker Desktop NAT limitation.
- [x] Add policy fixtures for every reported escape and prose false positive;
  scan all source CSS and applicable quickstart contexts.
- [x] Capture owner baseline; align headings, navigation, appearance and progress
  with dashboard primitives; migrate remaining primitive restyles to variants.
- [x] Record Serve migration, public font route ruling and documentation spacing.
- [x] Run sequential gates, isolated browser tests and comparison captures.
- [x] Check PVE read-only before live deployment; preserve owner/session state,
  verify anonymous ingress, commit logical steps and push s16-polish.

Rulings: no dependencies are needed. Fixed public font assets intentionally remain
public before CIDR/deny/owner checks; they carry no deployment or owner data.
The theme control stays hidden until its persisted client state is known.

## Implementation decisions

Socket admission uses fixed loopback and Compose gateway/sidecar addresses,
independently of `UMIAK_TRUSTED_PROXY_CIDRS`. The public listener ignores headers
from every peer. Existing network attachments are retained under the explicit
no-network-changes constraint. Docker Desktop host-publish NAT remains a trust
limit: a translated container and host proxy can have the same socket address.
README records Docker >=28, this limitation and PUBLIC_URL host pinning.

Quickstart keeps its pre-session renderer, consumes dashboard tokens/fonts and
matches heading weight/size, sidebar/nav/footer grouping, segmented icon theme
control, current-page state, brand divider and a square accessible progress bar.
Mobile navigation collapses at the dashboard breakpoint; short desktop sidebars
scroll. Dashboard theme controls remain hidden until persisted state is read.
Terminal/inline/theme controls and warning badges use primitive variants.

The policy remains dependency-free and lexical. It follows local class bindings
and cn/clsx/cva expressions as well as JSX/HTML attributes, avoiding prose matches.
Each reported escape has a fixture, including renderer CSS and indirect classes.
A first attempt to use the TypeScript compiler API was discarded because the
pinned TypeScript 7 package no longer exposes the old API; no dependency added.
Payload inline presentation moved into its existing host-theme stylesheet.

## Verification evidence

Evidence root (outside git): `/tmp/umiak-s16-polish-9fDNWP/`.
Owner before/after: `{before,after}/`: claim, pairing request, pairing approval,
sessions, setup in light/dark at 1440 and 390 px. Dashboard baseline is freshly
captured from the preceding accepted `umiak-s16r5-web:final` image using an isolated
store (`dashboard-before/`); current dashboard is `dashboard-local-after/`.
`comparisons/` contains 40 side-by-side PNGs, all owner views next to dashboard,
both themes and widths, before and after. `screenshots.txt` lists absolute paths.
No live owner credentials or sessions were used for screenshots.

- Build, lint, typecheck: pass (final logs); lint retains the pre-existing
  informational diagnostic in apps/mcp/test/windows-run.ts.
- Sequential workspace tests: all unchanged packages passed in `tests.log`,
  including 83 Python SDK tests; affected web rerun passes 283/283 in
  `web-tests-final.log`. The intermediate full run encountered the discarded
  compiler-API experiment; the final lexical policy and full web suite pass.
- Node quickstart/local/meta-proxy/canonical-fetch including compiled CLI:
  153/153, `node-final.log`.
- Shellcheck quickstart scripts and dev-cp deployment/preflight: pass,
  `shellcheck.log`. Go source was not changed.
- Playwright OIDC: 27/27 (`oidc.log`); local: 2/2 (`local-final.log`);
  quickstart: 1/1 (`quickstart-ui-final.log`). E2E typecheck passes.
- Unique projects `umiak-s16-polish-9fdnwp-{oidc,local,before}`, with
  UMIAK_E2E_PROJECT set; only these projects/volumes were torn down.
- Reviewer found indirect class factory scanning and short-window sidebar gaps;
  both fixed with fixtures/overflow handling. No other important findings.

## Live verification

`infra/dev-cp/deploy-quickstart.sh` redeployed CT 590 after its read-only
preflight. No sandbox VM 500–589 was present; pve received read-only commands
only. Gateway CA/tunnel/leaf checksums passed the deployment preservation check.
Owner state hash before/after is identical, including sessions; no owner login,
claim, pairing or approval was performed.

The first anonymous check caught the existing Linux bridge gateway at
172.29.116.128 (Docker allocated the ip_range start), rather than .1. Added only
this exact expected gateway to socket admission, gave it a positive fixture
(and .129 a negative one), reran all 153 Node tests, repeated read-only preflight,
copied the corrected mounted module and restarted only quickstart. No network
configuration changed. The final check (`live-fixed.log`) passes:

- LAN/tailnet :4180 return their actual HTTP origin; spoofed forwarded
  Host/Proto/For do not change metadata or issue an anonymous cookie.
- Serve :8443 returns its correct HTTPS origin and targets localhost:4181.
- Port 4181 is unreachable from both LAN and tailnet addresses.
- Protected API/setup/session endpoints return 401 anonymously on all origins.

Remaining limit: Docker Desktop may NAT a container through host.docker.internal
to an admitted gateway. This is indistinguishable at the HTTP socket; trust the
host's containers and pin proxy Hosts as documented. Fixed font assets are public
by ruling. No outstanding acceptance fixes; no Go source or dependencies changed.
