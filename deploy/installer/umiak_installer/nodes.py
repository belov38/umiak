"""Day-2 multi-node actions from the original root console.

Only the root installer uses PVE's existing pinned root SSH. The control plane
gets inventory requests and the restricted node-agent key, never root SSH keys.
"""

import base64
import dataclasses
import fcntl
import functools
import hashlib
import ipaddress
import json
import shlex
import time
from pathlib import Path

from . import day2, node_host, prepare_host, stack, state
from .ct import run_in
from .pve import CommandError, InstallerError, get, lvmthin_storages, write_secret

BOOTSTRAP = """import json,tempfile,pathlib,sys,os
os.umask(0o022)
p=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='umiak-node-') as d:
 root=pathlib.Path(d)/'umiak_installer';root.mkdir()
 for name,text in p['sources'].items():
  if pathlib.Path(name).name!=name or not name.endswith('.py'): raise ValueError('invalid helper source')
  (root/name).write_text(text)
 sys.path.insert(0,d)
 from umiak_installer.node_host import dispatch
 from umiak_installer.pve import Runner
 print(json.dumps(dispatch(Runner(),p['request'])))
"""


class HostConsole:
    def __init__(self, runner):
        self.runner = runner

    def call(self, node, op, **data):
        if not prepare_host.NAME.fullmatch(node):
            raise InstallerError("Invalid cluster node name")
        request = dict(data, node=node, op=op)
        if node == self.runner.hostname():
            return node_host.dispatch(self.runner, request)
        member = _target(self.runner, node)
        try:
            address = str(ipaddress.ip_address(member.get("ip", "")))
        except ValueError as error:
            raise InstallerError(f"Cluster IP is missing or invalid for {node}") from error
        # Match PVE::SSHInfo on PVE 9: per-node trust takes precedence. Never
        # import network-scanned keys or use a workstation's unrelated pins.
        known = f"/etc/pve/nodes/{node}/ssh_known_hosts"
        if not self.runner.path(known).is_file():
            known = "/etc/pve/priv/known_hosts"
        repair = f"Verify cluster SSH trust and run `pvecm updatecerts` on target {node}, then retry"
        if not self.runner.path(known).is_file():
            raise InstallerError(repair)
        # macOS tar may add binary AppleDouble ._*.py metadata beside sources.
        sources = {p.name: p.read_text() for p in Path(__file__).parent.glob("*.py") if not p.name.startswith(".")}
        command = [
            "ssh",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"HostKeyAlias={node}",
            "-o",
            f"UserKnownHostsFile={known}",
            "-o",
            "GlobalKnownHostsFile=none",
            "-o",
            "ConnectTimeout=10",
            "root@" + address,
            shlex.join(["python3", "-c", BOOTSTRAP]),
        ]
        try:
            result = self.runner.run(command, input=json.dumps({"sources": sources, "request": request}))
        except CommandError as error:
            if error.returncode == 255:
                raise InstallerError(f"Cluster SSH to {node} failed. {repair}") from error
            raise
        return json.loads(result)


READ_INVENTORY = """// Umiak node inventory; works before the S19 quickstart image is pulled.
import pg from '/app/packages/db/node_modules/pg/lib/index.js';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try {
 const state=(await pool.query('SELECT state FROM quickstart.setup WHERE id=true')).rows[0]?.state;
 const provider=state?.steps?.limits?.data?.providerId;
 if(!provider) throw Error('Finish the installer bootstrap first');
 const all=(await pool.query(`SELECT n.id AS "nodeId",n.name,n.state,n.node_agent_ref AS "sshHost",n.ram_cap_mb AS "ramCapMb",
 COALESCE(to_jsonb(n)->>'media_storage','local') AS "mediaStorage",
 to_jsonb(n)->>'retired_at' AS "retiredAt",st.name AS storage
 FROM runtime.nodes n
 LEFT JOIN LATERAL (SELECT name FROM runtime.storages WHERE node_id=n.id AND driver='lvmthin' ORDER BY name LIMIT 1) st ON true
 WHERE n.provider_id=$1 ORDER BY n.name`,[provider])).rows;
 console.log(JSON.stringify({nodes:all.filter(n=>!n.retiredAt),retiredNodes:all.filter(n=>n.retiredAt)}));
} catch(e) {console.error(e.message);process.exitCode=1;} finally {await pool.end();}
"""


class NodeConsole:
    def __init__(self, runner, current):
        self.runner, self.current = runner, current

    def call(self, op, **data):
        command = (
            ["node", "deploy/compose/quickstart/nodes.mjs"]
            if op != "list"
            else ["node", "--input-type=module", "-e", READ_INVENTORY]
        )
        argv = stack.compose("exec", "-T", "quickstart", "node", "deploy/compose/quickstart/run.mjs", *command)
        return json.loads(run_in(self.runner, self.current.ct_id, *argv, input=json.dumps(dict(data, op=op))))


def _capable(console):
    try:
        if not console.call("capabilities").get("multiNode"):
            raise InstallerError("Update the control plane to a multi-node-capable release first")
    except CommandError as error:
        raise InstallerError("Update the control plane to a multi-node-capable release first") from error


def candidates(runner, current, console=None):
    """Online cluster nodes that are not sandbox nodes yet (read-only)."""
    console = console or NodeConsole(runner, current)
    taken = {n["name"] for n in console.call("list")["nodes"]} | {current.node}
    members = [n for n in get(runner, "/cluster/status") if n.get("type") == "node"]
    return sorted(n["name"] for n in members if n.get("online") == 1 and n.get("name") not in taken)


def _target(runner, node):
    if not prepare_host.NAME.fullmatch(node or ""):
        raise InstallerError("Invalid cluster node name")
    members = [n for n in get(runner, "/cluster/status") if n.get("type") == "node"]
    member = next((n for n in members if n.get("name") == node and n.get("online") == 1), None)
    if not member:
        raise InstallerError("Choose an online node from this Proxmox cluster")
    return member


def _pinned(content, node, address, key):
    aliases = {node, address}
    for line in content.splitlines():
        parts = line.split()
        if len(parts) >= 3 and aliases.intersection(parts[0].split(",")):
            if " ".join(parts[1:3]) != key:
                raise InstallerError("Pinned node host key changed; verify and rotate it explicitly before adding the node")
    line = f"{address},{node} {key}"
    return content if line in content.splitlines() else content.rstrip() + "\n" + line + "\n"


def _serialized(action):
    @functools.wraps(action)
    def run(runner, *args, **kwargs):
        path = runner.path(prepare_host.STATE_DIR) / "node-actions.lock"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise InstallerError("Another sandbox node action is still running") from error
            return action(runner, *args, **kwargs)

    return run


def _ask_storage(runner, node, fallback, ui):
    """A new node's LVM-thin storage: asked interactively (names differ between nodes), otherwise the CP's."""
    if not getattr(ui, "interactive", False):
        return fallback
    from .main import UsageError  # main imports this module lazily

    names = [row["storage"] for row in lvmthin_storages(runner, node)]
    if not names:
        raise InstallerError(f"Node {node} has no LVM-thin storage; add one in Proxmox (Datacenter → Storage) first")

    def check(value):
        if value not in names:
            raise UsageError(f"No LVM-thin storage named {value} on {node}; available: {', '.join(names)}")
        return value

    return ui.ask(f"LVM-thin storage on {node} ({', '.join(names)})", fallback if fallback in names else names[0],
                  "--storage", check)


@_serialized
def add_node(runner, current, bundle, node, *, ui, storage=None, ram_cap_mb=None, console=None, host=None,
             confirmed=False):
    day2._require_node(runner, current)
    day2._require_complete(current)
    _target(runner, node)
    console, host = console or NodeConsole(runner, current), host or HostConsole(runner)
    _capable(console)
    inventory = console.call("list")["nodes"]
    existing = next((n for n in inventory if n["name"] == node), {})
    storage = storage or existing.get("storage") or _ask_storage(runner, node, current.answers["storage"], ui)
    ram_cap_mb = ram_cap_mb or existing.get("ramCapMb") or current.answers.get("ram_cap_mb") or 4096
    if not isinstance(ram_cap_mb, int) or not 2048 <= ram_cap_mb <= 8192:
        raise InstallerError("Sandbox node RAM cap must be 2048-8192 MiB")
    cfg = {
        "storage": storage,
        "gateway_ip": current.ct_ip,
        "guest_dns": current.answers["guest_dns"],
        "guest_subnet": current.answers.get("guest_subnet", "10.88.0.0/24"),
        "vmid_min": current.answers["vmid_min"],
        "vmid_max": current.answers["vmid_max"],
        "tpl_min": current.answers["tpl_min"],
        "tpl_max": current.answers["tpl_max"],
    }
    report = host.call(node, "inspect", config=cfg)
    for check in report["checks"]:
        if not check["ok"] and check["fix"] is None:
            raise InstallerError(f"Prerequisite {check['name']}: {check['detail']}")
    secrets = runner.path(day2.SECRETS_DIR)
    known = secrets / "known_hosts"
    merged = _pinned(known.read_text(), node, report["sshHost"], report["hostKey"])
    ui.say(f"Sandbox node {node} ({report['sshHost']}): storage {storage}, RAM limit {ram_cap_mb // 1024} GiB")
    host_fixes = [check for check in report["checks"] if not check["ok"]]
    for check in host_fixes:
        ui.say(check["fix"]["description"])
        for path, text in check["fix"]["files"].items():
            ui.say(f"  write {path}: {text.strip()}")
        for argv in check["fix"]["commands"]:
            ui.say("  run: " + " ".join(argv))
    ui.say(f"The installer adds the restricted Umiak node agent to {node} and joins it to the Umiak network.")
    # The user already said yes to this node: ask again only for host fixes, and default to yes.
    if confirmed and not host_fixes:
        pass
    elif confirmed and hasattr(ui, "ask_yes") and not getattr(ui, "yes", False):
        if not ui.ask_yes("Apply the host changes above?"):
            raise InstallerError("Cancelled; no sandbox node changes were applied")
    elif not ui.confirm("Apply these node changes?"):
        raise InstallerError("Cancelled; no sandbox node changes were applied")
    staged_node = {
        "name": node,
        "sshHost": report["sshHost"],
        "storage": storage,
        "mediaStorage": report["mediaStorage"],
        "ramCapMb": ram_cap_mb,
    }
    reservation = console.call("prepare-add", node=staged_node)
    if not reservation.get("ok") or not reservation.get("preparationId"):
        raise InstallerError("Node preparation reservation failed; no host changes applied")
    work = runner.path(prepare_host.STATE_DIR) / "work"
    binary = stack.extract_node_agent(
        runner, current.ct_id, stack.quickstart_image(current.release), work / "umiak-node-linux-amd64"
    )
    if hashlib.sha256(binary.read_bytes()).hexdigest() != bundle.node_agent_sha256:
        raise InstallerError("Installed image and installer bundle node-agent checksums differ; Update first")
    public = (secrets / "umiak-node_ed25519.pub").read_text().strip()
    members = sorted({n["name"] for n in inventory} | {node})
    result = host.call(
        node,
        "prepare",
        config=cfg,
        members=members,
        public_key=public,
        binary=base64.b64encode(binary.read_bytes()).decode(),
        sha256=bundle.node_agent_sha256,
    )
    if result["sshHost"] != report["sshHost"] or result["hostKey"] != report["hostKey"]:
        raise InstallerError("Node identity changed during preparation; not registering it")
    write_secret(known, merged)
    stack.push_secrets(runner, current.ct_id, {"known_hosts": known}, stack.quickstart_image(current.release))
    registered = console.call(
        "register",
        preparationId=reservation["preparationId"],
        node={
            "name": node,
            "sshHost": result["sshHost"],
            "storage": storage,
            "mediaStorage": result["mediaStorage"],
            "ramCapMb": ram_cap_mb,
        },
    )
    if not registered.get("ok"):
        raise InstallerError("Node verification/registration failed; inspect preparation and retry")
    return registered


PURGE_POLL_S = 5
PURGE_STALL_S = 600


def _sandbox_text(s):
    name = f' "{s["name"]}"' if s.get("name") else ""
    vmids = ", ".join(str(v) for v in s.get("vmids") or [])
    where = f", VMID {vmids}" if vmids else ""
    return f'{s["slug"]}{name} ({s["state"]}{where}) id {s["id"]}'


def _plan_lines(plan):
    node = plan["node"]
    lines = []
    if plan["sandboxes"]:
        lines.append(f"  Sandboxes ({len(plan['sandboxes'])}):")
        lines += [f"    {_sandbox_text(s)}" for s in plan["sandboxes"]]
    if plan["machines"]:
        lines.append(f"  Machines without a sandbox ({len(plan['machines'])}):")
        lines += [f"    VMID {m['vmid'] or '-'} ({m['state']}) id {m['id']}" for m in plan["machines"]]
    if plan["snapshots"]:
        lines.append(f"  Snapshots ({len(plan['snapshots'])}):")
        lines += [f"    {s['name'] or s['id']} ({s['kind']}, {s['state']})" for s in plan["snapshots"]]
    if plan["templates"]:
        lines.append(f"  Templates on {node} ({len(plan['templates'])}):")
        lines += [f"    {t['slug']} {t['version']} (VMID {t['vmid']})" for t in plan["templates"]]
    return lines or [f"  Nothing Umiak-owned is left on {node}."]


def _left(plan):
    """'1 sandbox, 2 snapshots' still to delete; empty when the purge is done."""
    parts = []
    for key, one, many in (("sandboxes", "sandbox", "sandboxes"), ("machines", "machine", "machines"),
                           ("snapshots", "snapshot", "snapshots")):
        if count := len(plan[key]):
            parts.append(f"{count} {one if count == 1 else many}")
    return ", ".join(parts)


def _left_items(plan):
    items = [f"sandbox {s['slug']} ({s['state']})" for s in plan["sandboxes"]]
    items += [f"machine VMID {m['vmid'] or '-'} ({m['state']})" for m in plan["machines"]]
    items += [f"snapshot {s['name'] or s['id']} ({s['state']})" for s in plan["snapshots"]]
    return ", ".join(items)


def _reason(error):
    """The console's own message: the last stderr line, not the pct/docker wrapper text."""
    lines = [line.strip() for line in (getattr(error, "stderr", "") or "").splitlines() if line.strip()]
    return lines[-1] if lines else str(error)


def _ids(plan):
    return [item["id"] for key in ("sandboxes", "machines", "snapshots") for item in plan[key]]


def _unconfirmed(plan, confirmed):
    """Live items that appeared after the operator confirmed the list."""
    items = [(f"sandbox {s['slug']}", s) for s in plan["sandboxes"]]
    items += [(f"machine VMID {m['vmid'] or '-'}", m) for m in plan["machines"]]
    items += [(f"snapshot {s['name'] or s['id']}", s) for s in plan["snapshots"]]
    return [label for label, item in items if item["state"] != "deleting" and item["id"] not in confirmed]


def _wait_purged(console, node_id, plan, confirmed, *, ui, sleep, clock):
    """Poll until the worker has deleted every sandbox, machine and snapshot; report progress."""
    node, last, changed = plan["node"], None, clock()
    while _left(plan):
        if fresh := _unconfirmed(plan, confirmed):
            raise InstallerError(
                f"{', '.join(fresh)} appeared on {node} while it was being removed and was not deleted; the confirmed "
                "deletions continue. Rerun the removal to review and delete it."
            )
        if _left(plan) != last:
            last, changed = _left(plan), clock()
            ui.say(f"  Deleting on {node}: {last} left")
        elif clock() - changed > PURGE_STALL_S:
            raise InstallerError(
                f"Deleting on {node} made no progress for {PURGE_STALL_S // 60} minutes; still left: "
                f"{_left_items(plan)}. Check that the control plane is running, then rerun the removal; "
                "it continues where it stopped."
            )
        sleep(PURGE_POLL_S)
        plan = console.call("removal-plan", nodeId=node_id)
    return plan


def _confirm_purge(node, plan, *, ui, delete_sandboxes):
    from .main import UsageError  # main imports this module lazily

    if not ui.confirm(f"Delete everything listed above and remove sandbox node {node}?"):
        raise InstallerError("Cancelled; no sandbox node changes were applied")
    if not (plan["sandboxes"] or plan["machines"] or plan["snapshots"]):
        return
    if not getattr(ui, "interactive", True):
        if not delete_sandboxes:
            raise UsageError(f"Node {node} still has sandboxes, machines or snapshots: rerun with --delete-sandboxes "
                             "to delete them")
        return
    # Typed even with --yes: sandboxes and snapshots are gone for good.
    if not ui.typed(f"Sandboxes and snapshots are deleted permanently. Type the node name {node} to continue", node):
        raise InstallerError("Cancelled; no sandbox node changes were applied")


@_serialized
def remove_node(runner, current, node, *, ui, console=None, host=None, delete_sandboxes=False, sleep=time.sleep,
                clock=time.monotonic):
    day2._require_node(runner, current)
    day2._require_complete(current)
    if node == current.node:
        # Host cleanup would wipe the installer's own state directory on this host.
        raise InstallerError(f"{node} runs the Umiak control plane; uninstall Umiak instead of removing this node")
    _target(runner, node)
    console, host = console or NodeConsole(runner, current), host or HostConsole(runner)
    _capable(console)
    listed = console.call("list")
    inventory = listed["nodes"]
    target = next((n for n in inventory if n["name"] == node), None)
    retired = next((n for n in listed.get("retiredNodes", []) if n["name"] == node), None)
    if target is None and retired is None:
        raise InstallerError("Node is not registered for sandbox use")
    retained = ("Other sandbox nodes keep their own templates and sandboxes. The control-plane CT, history and the "
                f"shared cluster key are retained; only the node-agent/config and Umiak SDN membership of {node} "
                "are removed.")
    if target is None:
        # A retry after the node was retired: only host cleanup is left.
        ui.say(f"Sandbox node {node} is already retired; finishing its host cleanup. {retained}")
        if not ui.confirm(f"Remove the Umiak node-agent and config from {node}?"):
            raise InstallerError("Cancelled; no sandbox node changes were applied")
        target = retired
    else:
        try:
            plan = console.call("removal-plan", nodeId=target["nodeId"])
        except CommandError as error:
            # Control planes before node purge (<= 0.4.1) have no removal-plan operation.
            raise InstallerError("Update the control plane first (menu: Update), then retry the node removal") from error
        ui.say(f"Removing sandbox node {node} deletes everything Umiak owns on it:")
        for line in _plan_lines(plan):
            ui.say(line)
        ui.say(retained)
        if plan["blockers"]:
            raise InstallerError(f"Cannot remove {node} yet: " + "; ".join(b["message"] for b in plan["blockers"]))
        _confirm_purge(node, plan, ui=ui, delete_sandboxes=delete_sandboxes)
        confirmed = _ids(plan)
        try:
            plan = console.call("purge", nodeId=target["nodeId"], confirmed=confirmed)
        except CommandError as error:
            raise InstallerError(f"Could not start deleting on {node}: {_reason(error)}") from error
        plan = _wait_purged(console, target["nodeId"], plan, set(confirmed), ui=ui, sleep=sleep, clock=clock)
        for template in plan["templates"]:
            label = f"{template['slug']} {template['version']} (VMID {template['vmid']})"
            ui.say(f"  Deleting template {label}")
            try:
                console.call("retire-template", nodeId=target["nodeId"], buildId=template["buildId"])
            except CommandError as error:
                raise InstallerError(
                    f"Could not delete template {label} on {node}: {_reason(error)}. Fix the cause and rerun the "
                    "removal; finished deletions are kept."
                ) from error
    result = console.call("retire", nodeId=target["nodeId"])
    if not result["ok"]:
        left = console.call("removal-plan", nodeId=target["nodeId"])
        details = [b["message"] for b in left["blockers"]]
        if _left_items(left):
            details.append("still left: " + _left_items(left))
        if not details:
            details = [", ".join(f"{b['kind']} {b['id']}" for b in result["blockers"])]
        raise InstallerError(f"Node removal is still blocked on {node}: " + "; ".join(details) +
                             ". Rerun the removal after fixing this.")
    remaining = sorted(n["name"] for n in inventory if n["name"] != node)
    host.call(node, "remove", remaining_nodes=remaining, control_plane_id=current.ct_id)
    return result


def remember(runner, current, state_path=None):
    names = [n["name"] for n in NodeConsole(runner, current).call("list")["nodes"]]
    updated = dataclasses.replace(current, sandbox_nodes=names)
    state.save(updated, state_path or runner.path(str(state.DEFAULT_PATH)))
    return updated


def refresh_agents(runner, current, bundle, *, ui):
    inventory = NodeConsole(runner, current).call("list")["nodes"]
    targets = [n for n in inventory if n["name"] != current.node]
    if not targets:
        return
    secrets = runner.path(day2.SECRETS_DIR)
    binary = stack.extract_node_agent(
        runner,
        current.ct_id,
        stack.quickstart_image(bundle.version),
        runner.path(prepare_host.STATE_DIR) / "work/umiak-node-linux-amd64",
    )
    public = (secrets / "umiak-node_ed25519.pub").read_text().strip()
    host = HostConsole(runner)
    for node in targets:
        ui.say("Updating restricted node-agent on " + node["name"])
        cfg = {
            "storage": node["storage"],
            "gateway_ip": current.ct_ip,
            "guest_dns": current.answers["guest_dns"],
            "guest_subnet": current.answers.get("guest_subnet", "10.88.0.0/24"),
            "vmid_min": current.answers["vmid_min"],
            "vmid_max": current.answers["vmid_max"],
            "tpl_min": current.answers["tpl_min"],
            "tpl_max": current.answers["tpl_max"],
        }
        host.call(
            node["name"],
            "update",
            config=cfg,
            public_key=public,
            binary=base64.b64encode(binary.read_bytes()).decode(),
            sha256=bundle.node_agent_sha256,
        )


def other_sandbox_nodes(runner, current, console=None) -> list[dict]:
    """Sandbox nodes besides this one (name, storage), from the control plane; the saved list if it is down."""
    if current.phase != "complete":
        return []
    try:
        listed = (console or NodeConsole(runner, current)).call("list")["nodes"]
        return [{"name": n["name"], "storage": n.get("storage")} for n in listed if n["name"] != current.node]
    except (CommandError, ValueError, KeyError):
        return [{"name": n, "storage": None} for n in current.sandbox_nodes if n != current.node]
