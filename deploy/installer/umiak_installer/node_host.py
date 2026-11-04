"""Root-only local node operations; called by the root installer, never the control plane."""

import base64
import dataclasses
import fcntl
import hashlib
import json
import shlex
import tempfile
import tomllib
from pathlib import Path

from . import checklist, prepare_host
from .pve import InstallerError, Runner, get, pending_sdn, write_secret


def _identity(runner, node):
    if not prepare_host.NAME.fullmatch(node or "") or runner.hostname() != node:
        raise InstallerError("Sandbox node identity does not match this host")


def _zone(runner, members, *, remove=None):
    if pending_sdn(runner):
        raise InstallerError("Refusing unrelated pending SDN changes")
    zone = get(runner, "/cluster/sdn/zones/umiak", "--pending", "1")
    if zone.get("type") != "simple" or zone.get("dhcp") != "dnsmasq":
        raise InstallerError("Unexpected Umiak SDN zone")
    # Empty `nodes` means ALL nodes in PVE. Keep a passive last zone until
    # explicit platform uninstall rather than accidentally enabling it everywhere.
    bridge = runner.path("/sys/class/net/vmbr0/bridge/mcast_hash_max")
    previous = bridge.read_text() if bridge.exists() else None
    try:
        current = {name.strip() for name in str(zone.get("nodes", "")).split(",") if name.strip()}
        desired = current | set(members)
        if remove:
            desired.discard(remove)
        # PVE treats an empty list as all cluster nodes, not zero nodes.
        if not desired:
            desired = current or {runner.hostname()}
        if desired != current:
            runner.run(["pvesh", "set", "/cluster/sdn/zones/umiak", "--nodes", ",".join(sorted(desired))])
        runner.run(["pvesh", "set", "/cluster/sdn"])
    finally:
        if previous is not None and bridge.read_text() != previous:
            bridge.write_text(previous)


def _unused(runner, node, control_plane_id):
    for kind in ("qemu", "lxc"):
        for vm in get(runner, f"/nodes/{node}/{kind}"):
            if kind == "lxc" and int(vm["vmid"]) == control_plane_id:
                continue
            cfg = get(runner, f"/nodes/{node}/{kind}/{int(vm['vmid'])}/config")
            if "umiak" in str(cfg.get("tags", "")) or any(
                "bridge=umiak0" in str(v) for k, v in cfg.items() if k.startswith("net")
            ):
                raise InstallerError(f"Node still has a Umiak guest or umiak0 attachment: {kind} {vm['vmid']}")
    # Refuse orphan Umiak LVs as well, including stopped interrupted builders.
    rows = json.loads(runner.run(["lvs", "--reportformat", "json", "-o", "lv_name,lv_tags"]))
    for report in rows.get("report", []):
        for lv in report.get("lv", []):
            if "umiak" in str(lv.get("lv_tags", "")).split(","):
                raise InstallerError("Node still has Umiak local disks: " + lv["lv_name"])


def _verify_local_sdn(runner, cfg):
    bridge = json.loads(runner.run(["ip", "-j", "address", "show", "dev", "umiak0"]))
    if not any(a.get("local") == "10.88.0.1" and a.get("prefixlen") == 24 for row in bridge for a in row.get("addr_info", [])):
        raise InstallerError("Verification failed: local umiak0 gateway 10.88.0.1/24 is missing")
    runner.run(["systemctl", "is-active", "dnsmasq@umiak.service"])
    subnet = get(runner, prepare_host.SUBNET)
    if str(subnet.get("snat")) != "1" or subnet.get("gateway") != "10.88.0.1" or not subnet.get("dhcp-range"):
        raise InstallerError("Verification failed: Umiak subnet gateway, DHCP or SNAT")
    # PVE SimplePlugin installs this subnet's SNAT in POSTROUTING on each node.
    rules = runner.run(["iptables", "-t", "nat", "-S", "POSTROUTING"])

    def snat(line):
        fields = shlex.split(line)

        def value(key):
            return fields[fields.index(key) + 1] if key in fields and fields.index(key) + 1 < len(fields) else None

        return (
            fields[:2] == ["-A", "POSTROUTING"]
            and value("-s") == "10.88.0.0/24"
            and value("-j") == "SNAT"
            and value("--to-source")
        )

    if not any(snat(line) for line in rules.splitlines()):
        raise InstallerError("Verification failed: local Umiak subnet SNAT rule is missing")
    # Reach the guest listener from this node before advertising it to placement.
    runner.run(["python3", "-c", "import socket,sys; socket.create_connection((sys.argv[1],443),10).close()", cfg.gateway_ip])


def dispatch(runner: Runner, request: dict) -> dict:
    _identity(runner, request.get("node"))
    # A disconnected SSH client may leave its helper alive. Serialize on the target too.
    if request.get("op") == "inspect":
        return _dispatch(runner, request)
    path = runner.path(prepare_host.STATE_DIR) / "node-helper.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallerError("A node helper is still running; wait before retrying") from error
        return _dispatch(runner, request)


def _dispatch(runner: Runner, request: dict) -> dict:
    node = request.get("node")
    _identity(runner, node)
    if request["op"] == "remove":
        _unused(runner, node, request["control_plane_id"])
        config = runner.path(prepare_host.NODE_CONFIG)
        if config.exists():
            cfg = tomllib.loads(config.read_text())
            if cfg.get("node") != node or cfg.get("vnet") != "umiak0":
                raise InstallerError("Refusing to remove a foreign node-agent configuration")
        if not config.exists() and runner.path(prepare_host.NODE_BINARY).exists():
            raise InstallerError("Cannot prove ownership of node-agent without its config")
        _zone(runner, request["remaining_nodes"], remove=node)
        # The forced-command line is cluster-wide. Never remove it for one node.
        for name in (prepare_host.NODE_BINARY, prepare_host.NODE_CONFIG):
            runner.path(name).unlink(missing_ok=True)
        return {"ok": True}
    if request["op"] not in ("inspect", "prepare", "update"):
        raise InstallerError("Unknown root node action")
    binary_data = None
    if request["op"] != "inspect":
        try:
            binary_data = base64.b64decode(request["binary"], validate=True)
        except ValueError as error:
            raise InstallerError("Invalid node-agent binary encoding") from error
        if hashlib.sha256(binary_data).hexdigest() != request["sha256"]:
            raise InstallerError("Node-agent checksum mismatch")
        if not prepare_host.PUBLIC_KEY.fullmatch(request["public_key"]):
            raise InstallerError("Invalid node-agent public key")
    cfg = prepare_host.PrepareConfig(node=node, **request["config"])
    checks = checklist.inspect(
        runner, node=node, storage=cfg.storage, ranges=((cfg.vmid_min, cfg.vmid_max), (cfg.tpl_min, cfg.tpl_max))
    )
    if request["op"] == "inspect":
        key = " ".join(runner.path("/etc/ssh/ssh_host_ed25519_key.pub").read_text().split()[:2])
        return {
            "checks": [dataclasses.asdict(c) for c in checks],
            "sshHost": prepare_host.node_address(runner, node),
            "hostKey": key,
            "mediaStorage": next(iter(prepare_host.media_storages(runner, node)), {}).get("storage", ""),
        }
    for check in checks:
        if not check.ok:
            if check.fix is None or request["op"] == "update":
                raise InstallerError(f"Prerequisite not met: {check.name}: {check.detail}")
            checklist.apply_fix(runner, check.fix)
    facts = prepare_host._preflight(runner, cfg)
    # This action extends an existing install. Never create/rotate the cluster
    # token or generate another private key on the added node.
    if not facts["user_exists"] or not facts["token_exists"]:
        raise InstallerError("The original Umiak cluster user/token is missing")
    for flag, principal in [("--users", prepare_host.USER_ID), ("--tokens", prepare_host.TOKEN_ID)]:
        for path, role in prepare_host._grants(cfg, facts["media_name"]):
            if not prepare_host._granted(facts["acls"], path, principal, role):
                if request["op"] == "update":
                    raise InstallerError("Node ACLs need repair; re-add this node explicitly")
                extra = ["--propagate", "0"] if path == "/" else []
                runner.run(["pveum", "acl", "modify", path, flag, principal, "--roles", role, *extra])
    work = runner.path(prepare_host.STATE_DIR)
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_secret(work / prepare_host.STAGED_NODE_CONFIG, prepare_host._node_config(cfg, facts))
    if request["op"] == "prepare":
        _zone(runner, request["members"])
        prepare_host._verify(runner, cfg, facts["media_name"])
        _verify_local_sdn(runner, cfg)
    installed = runner.path(prepare_host.NODE_BINARY)
    if (
        request["op"] == "update"
        and installed.exists()
        and hashlib.sha256(installed.read_bytes()).hexdigest() == request["sha256"]
    ):
        return {"ok": True, "unchanged": True}
    with tempfile.TemporaryDirectory() as temp:
        binary = Path(temp) / "umiak-node"
        binary.write_bytes(binary_data)
        prepare_host.install_node_agent(runner, binary, request["sha256"], request["public_key"])
    return {"ok": True, "sshHost": facts["node_ip"], "mediaStorage": facts["media_name"], "hostKey": facts["host_key"]}
