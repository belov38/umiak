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
def add_node(runner, current, bundle, node, *, ui, storage=None, ram_cap_mb=None, console=None, host=None):
    day2._require_node(runner, current)
    day2._require_complete(current)
    _target(runner, node)
    console, host = console or NodeConsole(runner, current), host or HostConsole(runner)
    _capable(console)
    inventory = console.call("list")["nodes"]
    existing = next((n for n in inventory if n["name"] == node), {})
    storage = storage or existing.get("storage") or _ask_storage(runner, node, current.answers["storage"], ui)
    ram_cap_mb = ram_cap_mb or existing.get("ramCapMb") or 4096
    if not isinstance(ram_cap_mb, int) or not 2048 <= ram_cap_mb <= 8192:
        raise InstallerError("Sandbox node RAM cap must be 2048-8192 MiB")
    cfg = {
        "storage": storage,
        "gateway_ip": current.ct_ip,
        "guest_dns": current.answers["guest_dns"],
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
    ui.say(f"Add sandbox node {node}: SSH {report['sshHost']}, storage {storage}, RAM cap {ram_cap_mb} MiB")
    for check in report["checks"]:
        if not check["ok"]:
            ui.say(check["fix"]["description"])
            for path, text in check["fix"]["files"].items():
                ui.say(f"  write {path}: {text.strip()}")
            for argv in check["fix"]["commands"]:
                ui.say("  run: " + " ".join(argv))
    ui.say(
        "Install restricted umiak-node/config, extend Umiak ACLs/SDN membership, pin SSH host key; "
        "no root key enters the control plane."
    )
    if not ui.confirm("Apply these node changes?"):
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


@_serialized
def remove_node(runner, current, node, *, ui, console=None, host=None):
    day2._require_node(runner, current)
    day2._require_complete(current)
    _target(runner, node)
    console, host = console or NodeConsole(runner, current), host or HostConsole(runner)
    _capable(console)
    listed = console.call("list")
    inventory = listed["nodes"]
    target = next((n for n in inventory + listed.get("retiredNodes", []) if n["name"] == node), None)
    if target is None:
        raise InstallerError("Node is not registered for sandbox use")
    ui.say(
        f"Remove sandbox node {node}: retain history/control-plane CT and shared cluster key; "
        "remove only its node-agent/config and narrow Umiak SDN membership."
    )
    if not ui.confirm("Remove this sandbox node if it is empty?"):
        raise InstallerError("Cancelled; no sandbox node changes were applied")
    result = console.call("retire", nodeId=target["nodeId"])
    if not result["ok"]:
        blockers = ", ".join(f"{b['kind']} {b['id']}" for b in result["blockers"])
        raise InstallerError("Node removal blocked: " + blockers)
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
