# Sandbox nodes in one Proxmox cluster

Run the installer again on the original control-plane host and choose **Add or
remove sandbox nodes**. For automation, pass `--action nodes --node-action add
--node pve2 --storage local-lvm --ram-cap-mb 4096 --non-interactive --yes` to
the installer. Remove uses `--node-action remove --node pve2` instead. Update
the control plane to a multi-node-capable release first; the installer checks
capabilities before changing a target host.

The installer uses the existing, strictly pinned PVE root SSH connection to
an online cluster member. It connects to the IP from cluster status with
`HostKeyAlias=<node>`, using PVE 9's per-node
`/etc/pve/nodes/<node>/ssh_known_hosts` when present, otherwise
`/etc/pve/priv/known_hosts`. Strict host-key checking and batch mode remain
enabled; no network keyscan or workstation trust is imported. If cluster trust
is missing or SSH verification fails, verify the cluster and run
`pvecm updatecerts` on the target node before retrying.
It prints prerequisite fixes, storage and RAM cap
before confirmation. It installs dnsmasq with the global service disabled,
enables forwarding persistently if needed, prepares only Umiak ACLs/SDN, and
installs the restricted node-agent. The cluster token/private key are reused;
only the new host's pinned public SSH key is added to `known_hosts`.
Before host changes, the database validates the requested storage/cap and
cordons the target with a durable preparation reservation. A failed attempt
stays unschedulable; rerun with the same configuration to resume safely.

`runtime.nodes` is authoritative. `/etc/pve/umiak/install-state.json` keeps a
bookkeeping list; editing it does not enroll, cordon or remove a sandbox node.
Update refreshes agents on registered nodes. If the original host's sandbox
role was retired, Update keeps the CT and does not reinstall its node-agent.

## Templates and smoke

In Setup, select a sandbox node for each build. The template is built once on that node, then its base disks are copied and
verified on the other sandbox nodes. Adding a node copies the existing active
templates without rebuilding. The setup queue shows Building then Copying with
verified-byte progress. Matching storage names do not imply shared disks or ISO files.
ISO storage comes from the registered node configuration. Rebuild requires
typing the recipe name and allocates a new free cluster-wide template VMID.
Each replica is promoted only after verification; failed copies preserve its previous active build. Existing sandboxes retain
their local disks and template identity.

Select a node for Smoke to create, execute in and delete a 2 GiB Linux sandbox
there. This uses a private operator-only dashboard operation. Normal create
continues to choose an eligible node automatically by free RAM; public API,
CLI and SDK create have no node selector. Fork, resume and snapshot-based create prefer home; under capacity pressure or
cordon S21 cold-moves data to another eligible node. Source disks survive until
the verified target owns the data. An offline source must return before copying.
Use `umiak start <id> --wait 100m` or `create/resume/fork --capacity-wait 100m
--wait-ready` to queue for RAM. `umiak cancel-start <id>` cancels a queued request.

A template build reserves an idle node before host work. Other nodes remain
usable. Interrupted jobs retain the reservation and block starts until an
operator has inspected their build/verification VMs. No automatic broad
cleanup runs after a restart.

## Removing a node

Stop and delete its sandboxes and snapshots first. Explicitly retire its
local templates. Removal lists remaining blocker IDs, including failed or
pending cleanup, and refuses without uninstalling the node-agent. Once empty,
the node is retired under the scheduler lock; local inventory is checked
again before agent/config removal. A partial cleanup can be retried using the
retained retired topology row. Re-adding preserves that row's ID/history.

The control-plane CT is independent of its host's sandbox role and is retained.
Other guests, `vmbr0`, unrelated firewall rules, global forwarding and dnsmasq
packages are retained. The cluster SSH forced-command authorization remains
for other/future sandbox nodes. When the final sandbox node retires, the empty
Umiak SDN zone is retained passively until platform uninstall: an empty PVE
`nodes` list means all nodes, so it must not be used to express no nodes.
Remove other sandbox nodes before uninstalling the platform; this avoids
leaving their local snapshots or agents without an authoritative registry.

## Root console inspection and recovery

The JSON console bridge has no HTTP endpoint. On the original PVE host, replace
`<CTID>` with the installer's control-plane container ID:

```sh
pct exec <CTID> -- docker compose --project-directory /opt/umiak -p umiak exec -T quickstart \
  node deploy/compose/quickstart/run.mjs node deploy/compose/quickstart/nodes.mjs <<'JSON'
{"op":"list"}
JSON
```

The result includes node IDs, active/interrupted build job IDs and template
build IDs. To explicitly delete and retire a verified Umiak template, send
`{"op":"retire-template","nodeId":"<node UUID>","buildId":"<build UUID>"}`
through the same bridge. It refuses non-template guests, protected/out-of-range
VMIDs, machine/snapshot references and an existing build reservation. A failed
PVE delete retains its retirement intent and reservation. Retry the same
`retire-template` request after a polling failure or console restart; it resumes
the recorded PVE task and verifies that the VM and local LV names are gone
before retiring history or freeing the template lease. A surviving retirement
process cannot be taken over.

If the DELETE response was lost before its task ID could be saved, inspect the
Proxmox task history. Retry the same request with `"taskUpid":"<UPID>"`.
Recovery accepts only an Umiak `qmdestroy` task for this VMID started after the
retirement intent. Uncertain ownership, task state or remaining disks keeps the
reservation. `cleanup-build` cannot clear a template retirement; use its
original `buildId` and retirement request.

After stopping the old builder process and removing its build/verification VMs,
send `{"op":"cleanup-build","nodeId":"<node UUID>","jobId":"<job ID>"}`.
It accepts interrupted jobs only, refuses a surviving builder process or
active Umiak PVE task, and requires all VMIDs leased by that job to be absent.
It releases only that job's leases. Local orphan disks are not deleted
implicitly and still block final host removal. Node preparation reservations
are recovered by rerunning Add with the same configuration.
If inventory cannot be read or ownership cannot be proved, repair the cause
and retry; do not bypass the guard by deleting topology rows or resetting keys.
