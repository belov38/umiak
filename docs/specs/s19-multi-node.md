# S19: multi-node sandboxes

Status: approved by Ilia through the S18 coordinator, 2026-11-04. Scope owner: Ilia. Depends on S18
(`s18-onboarding.md`); this does not restore browser Connect/Prepare.

## Intent

One Umiak installation uses several sandbox nodes in one Proxmox cluster.
Adding a node prepares it, makes its template availability visible, and lets
the scheduler use it when an appropriate local template is ready. Removing
a node must never orphan guests, local disks, builds or saved snapshots.

## Approaches and decisions

Proposed approach: keep S6 §8.4 automatic placement by available RAM and
independently build the same logical template on each selected node. No
public node selector. Fork, resume, recover and saved-snapshot create stay
on the node holding their disks. This uses the existing data model and
does not require transferring local LVM-thin data.

Alternative: expose node pinning in create, SDKs and dashboard. Useful for
operator placement policies, but expands the user contract beyond enabling
the existing scheduler. Another alternative, template replication/shared
storage, requires a disk transfer/storage design and is outside the stated
node-local build requirement. Ilia approved the proposed automatic-placement approach through the
coordinator on 2026-11-04.

Ilia separately authorized preparing all ms02 nodes, including `pve2`,
on 2026-11-04 through the coordinator, subject to the live restrictions below.

## Goals and boundaries

- Cold create can choose any eligible registered node with an active local
  build. Most free reserved RAM first, then stable node ID tie-break.
- Storage limits, RAM caps, clone concurrency and SSH endpoints are per node.
- Templates are logical catalog entries; active builds are per
  `(template_slug, node_id)`, not a single global build.
- Installer offers **Add or remove sandbox nodes** after S18 implementation
  lands on main. Browser setup remains Templates + Smoke.
- Removal refuses with a useful blocker list; it never automatically deletes
  sandboxes, snapshots or templates to make removal succeed.

No live migration, cross-node fork/snapshot copy, shared storage driver,
multi-cluster installer, HA control plane, automatic failover, public node
selection, warm-pool enablement, or new root shell access from control plane.
Existing corporate authentication is unchanged.

## Existing foundation and gaps

`packages/core/src/placement.ts` already orders active nodes with local
active builds, storage headroom and RAM. `template_builds_active_uq` already
enforces one active build per template/node. Worker infra registry already
caches clients by node ID and lifecycle records already hold node IDs.

Gaps: worker's global `UMIAK_NODE_SSH_HOST` can override every node; setup
and build invocation select the original connection node; template catalog
collapses builds into one newest version; admission does not recheck node
eligibility after waiting on its lock. Template builder's RAM accounting
currently counts other nodes too. Preserve the working single-node path.

## Source of truth and credentials

Confirmed S18 integration contract (coordinator, 2026-11-04):

- `runtime.providers`, `runtime.nodes`, `runtime.storages` are authoritative
  for scheduling. Installer state under `/etc/umiak` is bookkeeping only.
- One cluster PVE token, API URL and root CA; node API paths use the selected
  PVE node name. Each node has its own `node_agent_ref` SSH address.
- One cluster node-agent ed25519 private key in the PVE secrets volume.
  Restricted forced-command authorization is cluster-wide in
  `/etc/pve/priv/authorized_keys`. Binary/config and pinned host keys are
  per node. No arbitrary shell credential is handed to the control plane.
- `known_hosts` retains every participating node's pinned key. Key rotation
  is explicit; runtime never trusts `ssh-keyscan` automatically.
- Bootstrap upserts only its installer node, preserves IDs and other nodes,
  and never deletes or cordons nodes added later.

Worker routing uses the DB node endpoint, never the global bench/builder
SSH override. Refresh/invalidate cached clients when endpoint/configuration
changes or nodes retire; close old clients without leaking connections.

## Placement and concurrency

Preserve per-node advisory locking and team-before-node lock order. After
acquiring the candidate's node lock, recheck node/provider state, the
selected active build and its storage thresholds before reserving RAM or
creating disks. If a stale candidate is no longer eligible, release its lock
through the existing admission savepoint and try the next candidate. If
none succeeds, return existing retryable `out_of_capacity`.

Fork and saved-snapshot create also recheck eligibility under the same node
lock. Resume/recover keep existing semantics on a cordoned node with local
disks; such machines block final removal. No operation redirects a recorded
VM to another node when its home node is unavailable. VMIDs remain unique
cluster-wide through the provider allocator, including template VMIDs.

Template build start, promotion and removal use the same node serialization
as placement. A build must be durably recorded before host work begins;
restart/interruption leaves a visible blocker requiring inspection, not an
invisible background process. Do not hold a DB transaction across a build.

Builder ruling (preserves the existing setup build restriction): a template
build needs an idle target node. Under the node lock, first refuse if any
machine is running, powered-unknown or admitted to start; then durably claim
an exclusive build reservation. All create/fork admission, pool refill and
resume/recover/start gates refuse that reservation until completion. The
reservation covers builder verification VMs as well as the build VM. Other
nodes remain usable. A crashed/interrupted build retains its reservation
until its local test/build VMs are proven stopped/cleaned; merely restarting
the control plane cannot release it. Templates at rest and stopped sandbox
disks may remain. Check real PVE power state too; uncertain inventory refuses
start of a build. This avoids introducing concurrent builder/scheduler RAM
overcommit or redesigning RAM accounting for this stage.

## Templates, catalog and setup

Every build request names a registered node. Resolve its SSH endpoint,
storage, RAM cap and media storage server-side from trusted inventory;
reject unknown, retired or ineligible nodes. Single-node requests may omit
node for compatibility; ambiguous multi-node requests require selection.

Builds remain sequential initially. No replication: Linux, Linux desktop
and Windows builds produce independent manifests with their actual node,
storage and unique VMID. Windows ISO discovery/upload refers to the target
node's media store; never infer that another node has the same ISO.
Match build completion to its job/node/VMID and verified manifest, and
promote only that node's build. A rebuild on pve2 leaves pve's active build
and all existing sandbox disks unchanged. Failure preserves the previous
active build. Historical versions need not be identical across nodes.

Catalog and operator setup expose per-node availability and version, while
preserving existing summary fields for compatibility (newest active build,
not a promise that all nodes have that version). Availability means eligible
active node/build, not a guarantee of free RAM. `/v1/limits` continues to use
real placement/admission constraints. Never expose SSH endpoints, credentials
or administrative controls through team API keys. Exact additive catalog
fields and OpenAPI/SDK regeneration are implementation decisions.

Setup Templates lists registered nodes and their builds, accepts a node
selection for build/registration, and reports errors per node. Smoke test
can verify the chosen node without introducing public placement pinning;
an internal operator-only test path may select it. A registered node with
no template is shown as needing builds and gets no cold placements.

## Installer integration (after S18 code merge)

Run from the existing installation's root console. Reuse S18 checklist and
node-agent distribution. Explicitly show target node, exact prerequisite
changes and chosen local storages/RAM cap before any mutation. Privileged
preparation runs through the installer's root context, never by extending
the restricted node-agent with arbitrary command execution.

Add: verify cluster membership and pinned target identity; check/fix
dnsmasq (system service disabled), persistent forwarding, local storage and
agent; add pinned host key; verify restricted RPC and SDN; only then register
the node for scheduling. Failed preparation leaves it unschedulable and
reports any partial changes for retry. Rerun is idempotent.

SDN Simple zone/VNet/subnet, IPSet and firewall groups are cluster-wide,
with local NAT/DHCP bridges on selected nodes (architecture §7). Extend
Umiak's zone membership if scoped to a node list, apply only intended Umiak
changes, and verify local DHCP/SNAT and guest tunnel reachability. Refuse
unrelated pending SDN changes. No changes to `vmbr0`, other guests or
non-Umiak firewall policy. Keep the common forced-command authorization
while any sandbox node remains; removing one node must not revoke others.

## Safe removal

Builder ruling confirmed by coordinator: retain topology rows/history;
cordon/retire rather than physically DELETE. Extend the requested guard to
saved snapshots, warm/provisioning machines and running builds.

Under the node lock, enumerate non-deleted sandbox/machine references,
non-deleted snapshots, active templates, running/interrupted builds and
unfinished local cleanup. Return blocker kinds, IDs and counts with a clear
message. Deleting/failed/stopped machines still block until cleanup proves
their disks are gone. Active templates must be explicitly retired first.
Deprecated templates with retained local VMs/disks also need explicit
cleanup; never erase their history or underlying volumes implicitly.

If blocked, refuse removal without uninstalling the agent or changing SDN.
An explicit cordon can be used to prevent new work while the operator
clears blockers. Final removal durably marks retirement under the same lock
before host cleanup; placement/build start must then refuse this node.
Recheck local Umiak inventory before deleting only Umiak-owned agent/config
and narrowing zone membership. Ambiguous/unreadable inventory fails closed.
Do not revert global ip_forward or uninstall dnsmasq merely because Umiak
stops using a node. Keep the control-plane container independent of whether
its host is a sandbox node. Re-add explicitly revalidates prerequisites and
preserves historical topology IDs. Physical retirement representation and
DB migration are builder decisions; cordoned alone must not be mistaken for
fully removed when listing active installer membership.

Retired nodes must also be excluded from worker reconciliation and client
refresh before removing local agent access; a cordoned node ordinarily still
participates in reconciliation. Historical rows remain queryable.

## Acceptance

TDD must cover two nodes in one provider, differing template versions and
availability, free-RAM order/fallback, per-node SSH routing, independent
promotion, cluster VMID uniqueness, locality of fork/resume/snapshots,
stale-candidate races and removal versus build/promotion races. Verify each
removal blocker, idempotent add/re-add, interrupted preparation, bootstrap
preserving added nodes, and that removing one node preserves the other.

Full gate: mise-managed pnpm build/lint/typecheck/tests; Go build/vet/test
and golangci-lint matching CI workflows, including relevant Linux/Windows
checks. Report unavailable platform checks honestly. Fresh independent
acceptance subagent receives this spec and the diff, without implementer
conclusions. Fix blockers before merging main, pushing, updating roadmap
and reporting merged SHA/live evidence/open items to the coordinator.

Live: `ms02`, root SSH aliases `pve` and `pve2-lan`. Preparation of pve2 is authorized; coordinate the live window with S18. Sandbox VMIDs 500–589; templates use
configured separate range. VM 590 and guests below 500, 9000/9001, CT 110/111,
VMs 102/103/108 are off limits. Total live sandbox/test RAM <=8 GiB (e.g.
4+4), confirmed by coordinator. Build one Linux template per node, create
modest test workloads demonstrating placement on both, verify exec/tunnel,
snapshot/fork/resume locality and refusal to remove an occupied node. Stop
and delete test sandboxes, explicitly clean only test artifacts, and record
what was actually exercised. Coordinate live testing with S18 first.
