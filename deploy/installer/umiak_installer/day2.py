"""Day-2 actions on a finished install: Update, Sign in, Reset owner access, Uninstall.

Every action runs on the node that installed Umiak (the CT lives there, and
the node-agent is installed there). `ui` provides say(line), confirm(prompt)
and typed(prompt, word); with --yes in non-interactive mode both confirmations
pass, otherwise the caller refuses before anything runs.

Uninstall never touches non-Umiak objects: the CT only when it is the recorded
ID and tagged `umiak`, guests only in pool `umiak` and inside the recorded
sandbox/template VMID ranges (anything else refuses the whole run), and PVE
objects only by the names host preparation creates.
"""

import dataclasses
import hashlib
import ipaddress
import json
import re
import shutil
import time
from pathlib import Path

from . import ct, host_report, prepare_host, rollback, stack, state, tailnet
from .ct import run_in
from .pve import CommandError, InstallerError, Runner, exists, get, media_storages, pending_sdn

SECRETS_DIR = prepare_host.STATE_DIR + "/secrets"
STATE_DIR_ON_PVE = str(state.DEFAULT_PATH.parent)
IPSET = "/cluster/firewall/ipset/umiak-gateway"
EGRESS_GROUP = "/cluster/firewall/groups/umiak-egress"
QUICKSTART_DIR = "/app/deploy/compose/quickstart"
SIGNIN_LINK = re.compile(r"^/signin#([A-Z2-7-]+)$", re.M)
# Thin LVs Umiak creates (packages/pve/src/storage/lvmthin.ts): snapshots and VM disks,
# all tagged `umiak`. Removal is by full name only, never by tag alone.
SNAPSHOT_LV = re.compile(r"umiak-snap-[A-Za-z0-9_-]+")
VM_DISK_LV = re.compile(r"vm-(\d+)-disk-\d+")
NET_IP = re.compile(r"(?:^|,)ip=([^,/\s]+)")
# Printed by deploy/compose/quickstart/recover.mjs.
RECOVERED_CODE = re.compile(r"New one-time owner setup code: (\S+)")


# --- shared ---------------------------------------------------------------

def _require_node(runner: Runner, current: state.InstallState) -> None:
    if runner.hostname() != current.node:
        raise InstallerError(f"Umiak was installed on node {current.node}; run the installer there")


def _require_complete(current: state.InstallState) -> None:
    if current.phase != "complete":
        raise InstallerError("The install is not finished; rerun the installer and choose Resume install")


def _umiak_ct(runner: Runner, ct_id: int) -> dict | None:
    """The recorded CT row, None when it is gone; refuses a guest that is not an Umiak CT."""
    row = ct.existing(runner, ct_id)
    if row is not None and not ct.is_umiak_ct(row):
        raise InstallerError(f"Guest {ct_id} is not an Umiak container (type lxc, tag umiak); refusing to touch it")
    return row


def _running(runner: Runner, ct_id: int) -> bool:
    return "running" in runner.run(["pct", "status", str(ct_id)])


def _host(runner: Runner, current: state.InstallState) -> str:
    return current.tailnet_host or tailnet.parse(tailnet.status(runner, current.ct_id)).dns_name


def _sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def apply_stack(runner: Runner, ct_id: int, bundle, a: dict, node_ip: str, public_key: str,
                identity: tailnet.TailnetInfo, out_dir: Path, sleep, *, agent_only_if_changed: bool,
                sandbox_host: bool = True) -> bool:
    """Write the stack for `bundle`, refresh installer facts and secrets, start it, wait for the import.

    Shared by install and Update. The node-agent comes from the pulled image and
    is installed before the stack (re)starts, so the bootstrap import probes the
    right one; with agent_only_if_changed it is left alone when the installed
    binary already has the bundle's SHA256. Returns True when it was installed.
    """
    node = runner.hostname()
    work = runner.path(prepare_host.STATE_DIR) / "work"
    preview = stack.preview_domain(identity.ipv4)
    stack.write(runner, ct_id, bundle, {
        "UMIAK_VERSION": bundle.version,
        "UMIAK_PUBLIC_URL": f"https://{identity.dns_name}",
        "UMIAK_PREVIEW_DOMAIN": preview,
        "UMIAK_SSH_HOST": identity.ipv4,
        "UMIAK_GATEWAY_TLS_BIND": a["ct_ip"],
    }, work)
    stack.write_firewall(runner, ct_id, node_ip)
    stack.pull(runner, ct_id)
    stack.create(runner, ct_id)
    image = stack.quickstart_image(bundle.version)
    install_agent = sandbox_host and not (agent_only_if_changed
                         and _sha256(runner.path(prepare_host.NODE_BINARY)) == bundle.node_agent_sha256)
    if install_agent:
        binary = stack.extract_node_agent(runner, ct_id, image, work / "umiak-node-linux-amd64")
        prepare_host.install_node_agent(runner, binary, bundle.node_agent_sha256, public_key)
    if sandbox_host:
        host_report.write(host_report.collect(runner, node, a["vmid_min"], a["vmid_max"]), out_dir)
    limits = {"mediaStorage": media_storages(runner, node)[0]["storage"],
              "storage": a["storage"], "vmidMin": a["vmid_min"], "vmidMax": a["vmid_max"],
              "ramCapMb": a["ram_cap_mb"], "templateVmidMin": a["tpl_min"], "templateVmidMax": a["tpl_max"]}
    stack.write_install_json(stack.install_json(
        release=bundle.version, node=node, node_ip=node_ip, fingerprint=stack.pve_fingerprint(runner),
        ct_ip=a["ct_ip"], guest_dns=a["guest_dns"], tailnet_dns=identity.dns_name, tailnet_ip=identity.ipv4,
        limits=limits,
    ), out_dir)
    stack.write_network(runner, ct_id, stack.network_json(a["ct_ip"], preview, a["guest_dns"]), image, work)
    # The bootstrap import runs only when quickstart starts: if it already runs
    # (Update, Resume), restart it after the new secrets land.
    was_running = stack.quickstart_running(runner, ct_id)
    stack.push_secrets(runner, ct_id, {name: out_dir / name for name in stack.SECRET_NAMES}, image)
    stack.start(runner, ct_id, sleep=sleep)
    if was_running:
        stack.restart(runner, ct_id, "quickstart")
        stack.wait_healthy(runner, ct_id, sleep=sleep)
    stack.wait_bootstrap(runner, ct_id, sleep=sleep)
    return install_agent


# --- update ---------------------------------------------------------------

def _same_address(cidr: str, ip: str) -> bool:
    try:
        return ipaddress.ip_network(str(cidr), strict=False) == ipaddress.ip_network(ip)
    except ValueError:
        return False


def sync_gateway_ipset(runner: Runner, ct_ip: str) -> None:
    """The CT LAN address is in `umiak-gateway`; older installer-made entries for other addresses go.

    Only rows carrying the installer's comment are removed; an administrator's
    own entries stay. The current address is added before stale ones are removed.
    """
    try:
        rows = get(runner, IPSET)
    except CommandError as error:
        raise InstallerError("The IPSet umiak-gateway is missing; reinstall Umiak to recreate it") from error
    if not any(_same_address(row.get("cidr", ""), ct_ip) for row in rows):
        runner.run(["pvesh", "create", IPSET, "--cidr", ct_ip, "--comment", prepare_host.GATEWAY_COMMENT])
    for row in rows:
        if row.get("comment") == prepare_host.GATEWAY_COMMENT and not _same_address(row.get("cidr", ""), ct_ip):
            runner.run(["pvesh", "delete", f"{IPSET}/{row['cidr']}"])


def _require_ct_ip(runner: Runner, ct_id: int, ct_ip: str) -> None:
    """The CT's configured net0 address must still be the recorded one (IPSet, tunnel URL, install facts use it)."""
    config = runner.run(["pct", "config", str(ct_id)])
    net0 = next((line.split(":", 1)[1].strip() for line in config.splitlines() if line.startswith("net0:")), "")
    match = NET_IP.search(net0)
    actual = match.group(1) if match else None
    if actual != ct_ip:
        raise InstallerError(f"Control-plane container {ct_id} has address {actual or 'none (net0 has no static ip)'}, "
                             f"but Umiak was installed with {ct_ip}. Restore {ct_ip} in the container's network "
                             "settings (pct set ... --net0) and rerun Update; nothing was changed.")


def _wait_tailscale(runner: Runner, ct_id: int, sleep, attempts: int = 30) -> dict:
    """tailscaled needs a moment after a CT (re)start; wait up to ~60s for its backend to run."""
    info = {}
    for attempt in range(attempts):
        try:
            info = tailnet.status(runner, ct_id)
        except (CommandError, ValueError):
            info = {}
        if info.get("BackendState") == "Running":
            return info
        if attempt + 1 < attempts:
            sleep(2)
    raise InstallerError("Tailscale in the control-plane container is not running "
                         f"(state {info.get('BackendState', 'unknown')}); check: pct exec {ct_id} -- tailscale status")


def update(runner: Runner, current: state.InstallState, bundle, *, ui, sleep=time.sleep, progress=None,
           state_path: Path | None = None) -> state.InstallState:
    """Move the stack to `bundle` (a verified release). Volumes, owner state and setup are kept."""
    progress = progress or ui.say
    _require_node(runner, current)
    _require_complete(current)
    a, ct_id = current.answers, current.ct_id
    progress(f"Checking control-plane container {ct_id}")
    if _umiak_ct(runner, ct_id) is None:
        raise InstallerError(f"Control-plane container {ct_id} is gone; uninstall and install again")
    _require_ct_ip(runner, ct_id, a["ct_ip"])
    if not _running(runner, ct_id):
        runner.run(["pct", "start", str(ct_id)])
    progress("Checking the tailnet")
    info = _wait_tailscale(runner, ct_id, sleep)
    tailnet.require_https(info)
    identity = tailnet.parse(info)
    progress("Checking the guest gateway IPSet")
    sync_gateway_ipset(runner, a["ct_ip"])
    if prepare_host.ensure_zone_nodes(runner, runner.hostname()):
        progress("Scoped the SDN zone umiak to this node")
    out_dir = runner.path(SECRETS_DIR)
    public_key = " ".join((out_dir / "umiak-node_ed25519.pub").read_text().split()[:3])
    node_ip = prepare_host.node_address(runner, runner.hostname())
    from . import nodes
    inventory = nodes.NodeConsole(runner, current).call("list")["nodes"]
    sandbox_host = any(n["name"] == current.node for n in inventory)
    progress(f"Updating the Umiak stack to {bundle.version}")
    if apply_stack(runner, ct_id, bundle, a, node_ip, public_key, identity, out_dir, sleep,
                   agent_only_if_changed=True, sandbox_host=sandbox_host):
        ui.say("Node-agent updated on this node.")
    nodes.refresh_agents(runner, current, bundle, ui=ui)
    progress("Publishing the control plane on your tailnet")
    tailnet.serve(runner, ct_id)
    updated = dataclasses.replace(current, release=bundle.version, tailnet_host=identity.dns_name)
    state.save(updated, state_path or runner.path(str(state.DEFAULT_PATH)))
    return updated


# --- sign in and owner reset ----------------------------------------------

def _exec_quickstart(runner: Runner, ct_id: int, *argv: str) -> str:
    return run_in(runner, ct_id, *stack.compose("exec", "-T", "quickstart", *argv))


def signin(runner: Runner, current: state.InstallState, *, ui, progress=None) -> str:
    """A one-time sign-in link (10 minutes); other sessions stay valid."""
    (progress or ui.say)("Issuing a one-time sign-in code")
    _require_node(runner, current)
    _require_complete(current)
    try:
        output = _exec_quickstart(runner, current.ct_id, "umiak-signin", "--link")
    except CommandError as error:
        if "outstanding" in (error.stdout or ""):
            raise InstallerError(error.stdout.strip()) from error
        raise
    match = SIGNIN_LINK.search(output)
    if not match:
        raise InstallerError("umiak-signin printed no sign-in link")
    return f"https://{_host(runner, current)}/signin#{match.group(1)}"


def reset_owner(runner: Runner, current: state.InstallState, *, ui, progress=None) -> str | None:
    """Console recovery after a typed RESET: revokes all owner access, returns a new claim link."""
    _require_node(runner, current)
    _require_complete(current)
    ui.say("Reset owner access revokes every browser session, CLI credential and pending pairing. "
           "Setup, sandboxes and templates are kept. To add a browser, use 'Sign in a new browser' instead.")
    if not ui.typed("Type RESET to revoke all owner access", "RESET"):
        ui.say("Cancelled; owner access is unchanged.")
        return None
    (progress or ui.say)("Resetting owner access")
    output = _exec_quickstart(runner, current.ct_id, "node", f"{QUICKSTART_DIR}/run.mjs", "node",
                              f"{QUICKSTART_DIR}/recover.mjs")
    match = RECOVERED_CODE.search(output)
    if not match:
        raise InstallerError("The recovery command printed no new setup code")
    return tailnet.claim_link(_host(runner, current), match.group(1))


# --- uninstall ------------------------------------------------------------

def _ranges(a: dict) -> list[tuple[int, int]]:
    try:
        return [(int(a["vmid_min"]), int(a["vmid_max"])), (int(a["tpl_min"]), int(a["tpl_max"]))]
    except (KeyError, TypeError, ValueError):
        return []


def _pool_guests(runner: Runner, ct_id: int) -> list[dict]:
    if not exists(runner, "/pools/umiak"):
        return []
    members = (get(runner, "/pools/umiak") or {}).get("members") or []
    return [row for row in members if row.get("type") in ("qemu", "lxc") and int(row["vmid"]) != ct_id]


def _pve_steps(runner: Runner) -> list[tuple[str, list]]:
    """Umiak PVE objects that exist now, as (description, rollback action), in removal order.

    Uses the same names prepare_host creates and rollback's tolerant undo, so a
    rerun after a partial uninstall continues.
    """
    steps = []
    acls = get(runner, "/access/acl")
    for principal, flag in ((prepare_host.TOKEN_ID, "--tokens"), (prepare_host.USER_ID, "--users")):
        for row in acls:
            if row.get("ugid") == principal:
                steps.append((f"ACL {row['roleid']} on {row['path']} for {principal}",
                              ["command", ["pveum", "acl", "delete", row["path"], flag, principal,
                                           "--roles", row["roleid"]]]))
    users = {row["userid"] for row in get(runner, "/access/users")}
    if prepare_host.USER_ID in users:
        tokens = {row["tokenid"] for row in get(runner, f"/access/users/{prepare_host.USER_ID}/token")}
        if prepare_host.TOKEN_NAME in tokens:
            steps.append((f"API token {prepare_host.TOKEN_ID}",
                          ["command", ["pveum", "user", "token", "remove", prepare_host.USER_ID,
                                       prepare_host.TOKEN_NAME]]))
        steps.append((f"user {prepare_host.USER_ID}", ["command", ["pveum", "user", "delete", prepare_host.USER_ID]]))
    if exists(runner, "/pools/umiak"):
        steps.append(("pool umiak", ["command", ["pveum", "pool", "delete", "umiak"]]))
    roles = {row["roleid"] for row in get(runner, "/access/roles")}
    for role in ["UmiakPoC", *(name for name, _ in prepare_host.EXTRA_ROLES)]:
        if role in roles:
            steps.append((f"role {role}", ["command", ["pveum", "role", "delete", role]]))
    if exists(runner, EGRESS_GROUP):
        steps.append(("firewall security group umiak-egress", ["collection", EGRESS_GROUP]))
    if exists(runner, IPSET):
        steps.append(("firewall IPSet umiak-gateway", ["collection", IPSET]))
    for description, path in ((f"SDN subnet {prepare_host.SUBNET.rsplit('/', 1)[1]}", prepare_host.SUBNET),
                              ("SDN VNet umiak0", "/cluster/sdn/vnets/umiak0"),
                              ("SDN zone umiak", "/cluster/sdn/zones/umiak")):
        if exists(runner, path):
            steps.append((description, ["command", ["pvesh", "delete", path]]))
    return steps


def _thin_pool(runner: Runner, storage: str) -> tuple[str, str]:
    row = get(runner, "/storage/" + storage)
    vg, pool = str(row.get("vgname", "")), str(row.get("thinpool", ""))
    if row.get("type") != "lvmthin" or not prepare_host.NAME.fullmatch(vg) or not prepare_host.NAME.fullmatch(pool):
        raise InstallerError(f"Storage {storage} is not the LVM-thin storage Umiak was installed on")
    return vg, pool


def _guest_ids(runner: Runner) -> set[int]:
    return {int(row["vmid"]) for row in get(runner, "/cluster/resources", "--type", "vm")}


def umiak_lvs(runner: Runner, vg: str, pool: str, ranges: list[tuple[int, int]], keep: set[int]) -> list[str]:
    """Umiak thin LVs in vg/pool: tagged `umiak` and either a snapshot (`umiak-snap-*`) or a VM disk
    (`vm-<id>-disk-*`) of a VMID inside the Umiak ranges that is not in `keep` (existing guests)."""
    report = json.loads(runner.run(["lvs", "--reportformat", "json", "-o", "lv_name,vg_name,pool_lv,lv_tags", vg]))
    found = []
    for row in (report.get("report") or [{}])[0].get("lv", []):
        name = row.get("lv_name", "")
        tags = str(row.get("lv_tags", "")).split(",")
        if row.get("vg_name") != vg or row.get("pool_lv") != pool or "umiak" not in tags:
            continue
        disk = VM_DISK_LV.fullmatch(name)
        if SNAPSHOT_LV.fullmatch(name) or (
            disk and int(disk.group(1)) not in keep and any(low <= int(disk.group(1)) <= high for low, high in ranges)
        ):
            found.append(name)
    return sorted(found)


def _sdn_removed(steps) -> bool:
    return any(description.startswith("SDN ") for description, _ in steps)


def _remove_node_files(runner: Runner) -> None:
    prepare_host.remove_node_agent_key_lines(runner.path(prepare_host.AUTHORIZED_KEYS))
    for name in (prepare_host.NODE_BINARY, prepare_host.NODE_CONFIG):
        runner.path(name).unlink(missing_ok=True)


def uninstall(runner: Runner, current: state.InstallState, remove_pve_objects: bool, remove_guests: bool, *, ui,
              progress=None, state_path: Path | None = None) -> None:
    """Remove the control plane and, on request, Umiak guests and Umiak PVE objects.

    All checks run before the first change; the full list of destructive steps
    is shown and confirmed (typed DELETE when guests or PVE objects go).
    """
    progress = progress or ui.say
    _require_node(runner, current)
    from . import nodes
    nodes.require_detached_others(runner, current)
    ct_id = current.ct_id
    ct_row = _umiak_ct(runner, ct_id)

    guests = _pool_guests(runner, ct_id)
    ranges = _ranges(current.answers)
    if remove_guests:
        foreign = [row for row in guests if row.get("type") != "qemu"
                   or not any(low <= int(row["vmid"]) <= high for low, high in ranges)]
        if foreign:
            ids = ", ".join(str(row["vmid"]) for row in foreign)
            raise InstallerError(f"Pool umiak contains guests outside the Umiak VMID ranges: {ids}. "
                                 "Move them out of the pool first; nothing was changed.")
    elif remove_pve_objects and guests:
        ids = ", ".join(str(row["vmid"]) for row in guests)
        raise InstallerError(f"The pool umiak still has guests ({ids}); also remove the Umiak sandboxes and "
                             "templates, or keep the Proxmox objects. Nothing was changed.")
    lv_target = None
    lv_names: list[str] = []
    if remove_guests:
        if "storage" not in current.answers or not ranges:
            raise InstallerError("The installer state has no storage or VMID ranges; cannot identify Umiak disks")
        lv_target = _thin_pool(runner, current.answers["storage"])
        # Disks of the guests about to be destroyed count too: PVE normally removes them.
        doomed = {int(row["vmid"]) for row in guests}
        lv_names = umiak_lvs(runner, *lv_target, ranges, _guest_ids(runner) - doomed)
    pve_steps = []
    if remove_pve_objects:
        if pending_sdn(runner):
            raise InstallerError("Pending SDN changes must be applied or reverted by the administrator first; "
                                 "removing the Umiak zone applies SDN. Nothing was changed.")
        pve_steps = _pve_steps(runner)

    plan = []
    if ct_row is not None:
        plan.append(f"stop and destroy control-plane container {ct_id} with its Docker volumes "
                    "(owner state, database, guest CA)")
    if remove_guests:
        plan += [f"destroy {row['type']} {row['vmid']} ({row.get('name', 'unnamed')}) on {row.get('node')}"
                 for row in guests]
        plan += [f"remove LV {lv_target[0]}/{name} if PVE leaves it (Umiak snapshot or guest disk)" for name in lv_names]
    if remove_pve_objects:
        plan += [f"remove {description}" for description, _ in pve_steps]
        if _sdn_removed(pve_steps):
            plan.append("apply SDN (pvesh set /cluster/sdn)")
        plan += [f"remove {prepare_host.NODE_BINARY} and {prepare_host.NODE_CONFIG}",
                 f"remove the umiak-node forced-command line from {prepare_host.AUTHORIZED_KEYS} (other lines kept)",
                 f"remove {STATE_DIR_ON_PVE} and {prepare_host.STATE_DIR} (installer state and secrets)"]
    else:
        plan.append(f"remove the installer state {state.DEFAULT_PATH}")
    ui.say("Uninstall will:")
    for line in plan:
        ui.say("  - " + line)
    if not remove_guests and guests:
        ui.say(f"Umiak guests in pool umiak are kept: {', '.join(str(row['vmid']) for row in guests)}.")
    if not remove_pve_objects:
        ui.say("Umiak Proxmox objects (user, roles, pool, SDN, firewall) and the node-agent are kept.")
    if remove_guests or remove_pve_objects:
        confirmed = ui.typed("This cannot be undone. Type DELETE to continue", "DELETE")
    else:
        confirmed = ui.confirm("Proceed?")
    if not confirmed:
        raise InstallerError("Cancelled; nothing was changed")

    if ct_row is not None:
        progress(f"Stopping control-plane container {ct_id}")
        if _running(runner, ct_id):
            runner.run(["pct", "stop", str(ct_id)])
    if remove_guests:
        for row in guests:
            path = f"/nodes/{row['node']}/{row['type']}/{int(row['vmid'])}"
            progress(f"Destroying {row['type']} {row['vmid']}")
            # Re-read: the guest may have started since the plan was shown.
            if get(runner, path + "/status/current").get("status") != "stopped":
                runner.run(["pvesh", "create", path + "/status/stop"])
            runner.run(["pvesh", "delete", path, "--purge", "1", "--destroy-unreferenced-disks", "1"])
        # Snapshots belong to no VM; disks of destroyed guests may survive a failed purge.
        vg = lv_target[0]
        # Only LVs listed in the plan that still exist and still qualify.
        for name in sorted(set(lv_names) & set(umiak_lvs(runner, *lv_target, ranges, _guest_ids(runner)))):
            progress(f"Removing LV {vg}/{name}")
            runner.run(["lvremove", "-y", f"{vg}/{name}"])
    if ct_row is not None:
        progress(f"Destroying control-plane container {ct_id}")
        runner.run(["pct", "destroy", str(ct_id), "--purge", "1"])
    if remove_pve_objects:
        progress("Removing the node-agent from this node")
        _remove_node_files(runner)
        progress("Removing Umiak Proxmox objects")
        for _, action in pve_steps:
            rollback._undo(action, runner.run)
        if _sdn_removed(pve_steps):
            installer_state = runner.path(prepare_host.STATE_DIR)
            try:
                runner.run(["pvesh", "set", "/cluster/sdn"])
            finally:
                rollback.restore_bridge(installer_state, runner.run)
        shutil.rmtree(runner.path(STATE_DIR_ON_PVE), ignore_errors=True)
        shutil.rmtree(runner.path(prepare_host.STATE_DIR), ignore_errors=True)
    (state_path or runner.path(str(state.DEFAULT_PATH))).unlink(missing_ok=True)
    ui.say(f"Remove the device {current.answers.get('hostname', 'umiak')} from your tailnet: {tailnet.MACHINES_URL}")
