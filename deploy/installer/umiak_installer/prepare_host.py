"""Local Proxmox host preparation for Umiak (run as root on the PVE node).

Creates or verifies only Umiak-scoped objects: umiak@pve, its roles, token and
ACLs, pool `umiak`, SDN zone `umiak` / VNet `umiak0` / subnet 10.88.0.0/24,
IPSet `umiak-gateway` and security group `umiak-egress`. It never touches
vmbr0's configuration, other guests or non-Umiak objects, and refuses to run
while foreign SDN changes are pending (applying SDN would commit them).

Every check runs before the first change. Changes are journaled and a systemd
timer rolls them back if the run does not finish; a failing run rolls back
in-process. Commands are argv lists only. Secrets go to `out_dir` with mode
0600 and are never printed.
"""

import base64
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import rollback
from .pve import CommandError, InstallerError, Runner, exists, get, media_storages, pending_sdn, write_secret

USER_ID = "umiak@pve"
TOKEN_NAME = "umiak"
TOKEN_ID = USER_ID + "!" + TOKEN_NAME
STATE_DIR = "/var/lib/umiak-installer"
ROLLBACK_UNIT = "umiak-installer-rollback"
NODE_BINARY = "/usr/local/bin/umiak-node"
NODE_CONFIG = "/etc/umiak-node.toml"
AUTHORIZED_KEYS = "/etc/pve/priv/authorized_keys"
STAGED_NODE_CONFIG = "umiak-node.toml"
NAME = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]*")
PUBLIC_KEY = re.compile(r"ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\s]+)?")

POC_PRIVS = (
    "VM.Allocate VM.Audit VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk "
    "VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt VM.GuestAgent.Audit "
    "VM.GuestAgent.FileRead VM.GuestAgent.FileWrite VM.GuestAgent.FileSystemMgmt VM.GuestAgent.Unrestricted Pool.Audit"
)
EXTRA_ROLES = [
    ("UmiakTemplateMedia", "Datastore.AllocateTemplate Datastore.Audit"),
    ("UmiakConsole", "VM.Console"),
    ("UmiakMediaDownload", "Sys.AccessNetwork"),
    ("UmiakDatacenterAudit", "Sys.Audit"),
]
DENY_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16",
              "224.0.0.0/4", "::/1", "8000::/1"]
EGRESS_RULES = [
    {"type": "out", "action": "ACCEPT", "proto": "tcp", "dport": "443", "dest": "+umiak-gateway", "enable": 1},
    *[{"type": "out", "action": "DROP", "dest": cidr, "enable": 1} for cidr in DENY_CIDRS],
]
TOPOLOGY = [
    ("/cluster/sdn/zones/umiak", {"type": "simple", "ipam": "pve", "dhcp": "dnsmasq"}),
    ("/cluster/sdn/vnets/umiak0", {"zone": "umiak", "isolate-ports": 1}),
]
SUBNET = "/cluster/sdn/vnets/umiak0/subnets/umiak-10.88.0.0-24"
SECRET_FILES = ("pve-token", "pve-token-id", "pve-root-ca.pem", "umiak-node_ed25519", "umiak-node_ed25519.pub",
                "known_hosts")


@dataclass(frozen=True)
class PrepareConfig:
    node: str
    storage: str
    gateway_ip: str
    guest_dns: str = "1.1.1.1"
    vmid_min: int = 500
    vmid_max: int = 589
    tpl_min: int = 600
    tpl_max: int = 699
    # Address the control plane uses for SSH to this node; default: the node's
    # cluster address from /cluster/status.
    node_ip: str | None = None


@dataclass(frozen=True)
class PrepareResult:
    token_id: str
    media_storage: str
    node_ip: str
    public_key: str
    files: dict[str, Path] = field(default_factory=dict)


def dnsmasq_service_enabled(runner: Runner) -> bool:
    """The system-wide dnsmasq must stay disabled: PVE SDN runs its own instances."""
    try:
        state = runner.run(["systemctl", "is-enabled", "dnsmasq"])
    except CommandError as error:  # non-zero for disabled, masked, not-found
        state = error.stdout.strip()
    return state in ("enabled", "enabled-runtime", "alias")


def _grants(cfg: "PrepareConfig", media_name: str) -> list[tuple[str, str]]:
    return [
        ("/pool/umiak", "UmiakPoC"),
        ("/storage/" + cfg.storage, "PVEDatastoreUser"),
        ("/sdn/zones/umiak", "PVESDNUser"),
        ("/storage/" + media_name, "UmiakTemplateMedia"),
        ("/pool/umiak", "UmiakConsole"),
        ("/nodes/" + cfg.node, "UmiakMediaDownload"),
        # Root-only read access is needed because PVE otherwise omits http_proxy.
        ("/", "UmiakDatacenterAudit"),
    ]


def _granted(acls, path, principal, role):
    return any(x.get("path") == path and x.get("ugid") == principal and x.get("roleid") == role for x in acls)


def _rule_matches(row, rule):
    return all(str(row.get(key, "")) == str(value) for key, value in rule.items())


def _validate(cfg: PrepareConfig) -> None:
    if not NAME.fullmatch(cfg.node) or not NAME.fullmatch(cfg.storage):
        raise InstallerError("Invalid node or storage name")
    try:
        ipaddress.IPv4Address(cfg.gateway_ip)
        ipaddress.ip_address(cfg.guest_dns)
        if cfg.node_ip is not None:
            ipaddress.ip_address(cfg.node_ip)
    except ValueError as error:
        raise InstallerError(f"Invalid address: {error}") from error
    for low, high in [(cfg.vmid_min, cfg.vmid_max), (cfg.tpl_min, cfg.tpl_max)]:
        if not (isinstance(low, int) and isinstance(high, int) and 100 <= low <= high <= 999_999_999):
            raise InstallerError("Invalid VMID range")
    if cfg.vmid_min <= cfg.tpl_max and cfg.tpl_min <= cfg.vmid_max:
        raise InstallerError("Sandbox and template VMID ranges overlap")


def _preflight(runner: Runner, cfg: PrepareConfig) -> dict:
    """All checks, strictly read-only. Raises InstallerError before any change."""
    _validate(cfg)
    if runner.euid() != 0:
        raise InstallerError("Run the installer as root on the Proxmox node")
    if runner.hostname() != cfg.node:
        raise InstallerError("Node name does not match this host; refusing to prepare another node")
    for executable in ["pvesh", "pveum", "ssh-keygen", "systemd-run", "ifquery", "ip"]:
        try:
            runner.run(["which", executable])
        except CommandError as error:
            raise InstallerError(f"Required program {executable} is missing") from error
    try:
        check = runner.run(["ifquery", "--check", "-a"])
    except CommandError as error:
        check = error.stdout
    if "[fail]" in check:
        raise InstallerError("Host network configuration differs from live state; refusing SDN apply")
    if not runner.path("/usr/sbin/dnsmasq").exists() or dnsmasq_service_enabled(runner):
        raise InstallerError("Install dnsmasq and dnsmasq-utils with its system service disabled first")
    if runner.run(["sysctl", "-n", "net.ipv4.ip_forward"]) != "1":
        raise InstallerError("Enable IPv4 forwarding first")
    if int(get(runner, "/cluster/firewall/options").get("enable", 0)) != 1:
        raise InstallerError("The cluster firewall must be enabled first")
    if pending_sdn(runner):
        raise InstallerError("Pending SDN changes must be applied or reverted by the administrator first")
    for path, expected in TOPOLOGY:
        if exists(runner, path):
            current = get(runner, path)
            if any(str(current.get(key)) != str(value) for key, value in expected.items()):
                raise InstallerError("Existing Umiak topology differs from the expected one: " + path)
    if exists(runner, "/cluster/firewall/groups/umiak-egress"):
        # Existing rules must be the expected ones in order (missing ones are added).
        cursor = 0
        for row in sorted(get(runner, "/cluster/firewall/groups/umiak-egress"), key=lambda row: int(row.get("pos", 0))):
            while cursor < len(EGRESS_RULES) and not _rule_matches(row, EGRESS_RULES[cursor]):
                cursor += 1
            if cursor == len(EGRESS_RULES):
                raise InstallerError("Existing umiak-egress firewall group differs from the expected rules")
            cursor += 1
    media = media_storages(runner, cfg.node)
    if not media:
        raise InstallerError("An enabled directory storage with import and iso content is required")
    media_name, media_path = media[0]["storage"], str(media[0].get("path", ""))
    if not NAME.fullmatch(media_name) or not media_path.startswith("/"):
        raise InstallerError("Invalid template media storage configuration")
    try:
        storage = get(runner, "/storage/" + cfg.storage)
    except CommandError as error:
        raise InstallerError("Storage not found: " + cfg.storage) from error
    if storage.get("type") != "lvmthin" or not storage.get("vgname") or not storage.get("thinpool"):
        raise InstallerError("Selected storage must be an existing LVM-thin storage with VG and thinpool")
    if not NAME.fullmatch(str(storage["vgname"])) or not NAME.fullmatch(str(storage["thinpool"])):
        raise InstallerError("Unexpected LVM names on the selected storage")
    node_ip = cfg.node_ip or next(
        (row.get("ip") for row in get(runner, "/cluster/status") if row.get("type") == "node" and row.get("name") == cfg.node),
        None,
    )
    if not node_ip:
        raise InstallerError("Cannot determine this node's address; pass it explicitly")
    ipaddress.ip_address(node_ip)
    host_key = runner.path("/etc/ssh/ssh_host_ed25519_key.pub").read_text().split()
    if len(host_key) < 2 or host_key[0] != "ssh-ed25519":
        raise InstallerError("This node's ed25519 SSH host key is missing")
    users = json.loads(runner.run(["pveum", "user", "list", "--output-format", "json"]))
    user_exists = any(row["userid"] == USER_ID for row in users)
    tokens = json.loads(runner.run(["pveum", "user", "token", "list", USER_ID, "--output-format", "json"])) if user_exists else []
    bridge = runner.path("/sys/class/net/vmbr0/bridge/mcast_hash_max")
    return {
        "media_name": media_name,
        "media_path": media_path,
        "storage": storage,
        "node_ip": node_ip,
        "host_key": " ".join(host_key[:2]),
        "roles": {row["roleid"] for row in json.loads(runner.run(["pveum", "role", "list", "--output-format", "json"]))},
        "user_exists": user_exists,
        "token_exists": any(row["tokenid"] == TOKEN_NAME for row in tokens),
        "acls": get(runner, "/access/acl"),
        "bridge": {"path": str(bridge), "value": bridge.read_text().strip() if bridge.exists() else None},
    }


class _Journal:
    def __init__(self, runner: Runner, state: Path):
        self.runner = runner
        self.state = state
        self.actions = []

    def record(self, action):
        self.actions.append(action)
        rollback.write_journal(self.state, self.actions)

    def _forward(self, argv):
        # The undo is journaled before the forward command so a crash right
        # after it succeeds is still rolled back. If the command itself fails,
        # PVE did not create the object: drop the undo again so a replay does
        # not try to delete something that never existed. (Undoing a missing
        # object is also tolerated by rollback, as a second line of defence.)
        try:
            return self.runner.run(argv)
        except BaseException:
            self.actions.pop()
            rollback.write_journal(self.state, self.actions)
            raise

    def backup(self, path: Path):
        if path.exists():
            self.record(["file", str(path), base64.b64encode(path.read_bytes()).decode(), path.stat().st_mode & 0o777])
        else:
            self.record(["file", str(path), None, 0o600])

    def mutate(self, argv, reverse):
        self.record(["command", list(reverse)])
        return self._forward(argv)

    def create(self, path, child, *args) -> bool:
        if exists(self.runner, child):
            return False
        if "/firewall/" in child:
            self.record(["collection", child])
        else:
            self.record(["command", ["pvesh", "delete", child]])
        self._forward(["pvesh", "create", path, *args])
        return True


def _arm(runner: Runner, state: Path, bridge: dict) -> None:
    script = state / "rollback.py"
    script.write_text(Path(rollback.__file__).read_text())
    script.chmod(0o700)
    write_secret(state / rollback.BRIDGE, json.dumps(bridge))
    rollback.write_journal(state, [])
    (state / rollback.ACTIVE).write_text("active")
    try:
        runner.run(["systemd-run", "--quiet", "--collect", f"--unit={ROLLBACK_UNIT}", "--on-active=5min",
                    "/usr/bin/python3", str(script), str(state)])
    except BaseException:
        # Nothing changed yet; without a timer the marker would block every rerun.
        (state / rollback.ACTIVE).unlink(missing_ok=True)
        raise


def _stop_timer(runner: Runner) -> None:
    # The timer may already have fired or been collected; stopping is best effort.
    try:
        runner.run(["systemctl", "stop", ROLLBACK_UNIT + ".timer"])
    except CommandError:
        pass


def _apply(runner: Runner, cfg: PrepareConfig, facts: dict, out_dir: Path, journal: _Journal) -> None:
    roles = facts["roles"]
    if "UmiakPoC" not in roles:
        journal.mutate(["pveum", "role", "add", "UmiakPoC", "--privs", POC_PRIVS], ["pveum", "role", "delete", "UmiakPoC"])
    if not exists(runner, "/pools/umiak"):
        journal.mutate(["pveum", "pool", "add", "umiak", "--comment", "Umiak"], ["pveum", "pool", "delete", "umiak"])
    if not facts["user_exists"]:
        journal.mutate(["pveum", "user", "add", USER_ID, "--comment", "Umiak"], ["pveum", "user", "delete", USER_ID])

    # PVE shows a token secret only once. Reuse the stored one; if it is lost,
    # rotate the installer-owned token instead of dead-ending (old setup-prep).
    token_file = out_dir / "pve-token"
    if not (facts["token_exists"] and token_file.exists()):
        journal.backup(token_file)
        if facts["token_exists"]:
            runner.run(["pveum", "user", "token", "remove", USER_ID, TOKEN_NAME])
        added = journal.mutate(
            ["pveum", "user", "token", "add", USER_ID, TOKEN_NAME, "--privsep", "1", "--output-format", "json"],
            ["pveum", "user", "token", "remove", USER_ID, TOKEN_NAME],
        )
        write_secret(token_file, json.loads(added)["value"])
    # Removing a token also drops its ACL entries in PVE: read ACLs only now.
    acls = get(runner, "/access/acl")

    for role, privileges in EXTRA_ROLES:
        if role not in roles:
            journal.mutate(["pveum", "role", "add", role, "--privs", privileges], ["pveum", "role", "delete", role])
    for flag, principal in [("--users", USER_ID), ("--tokens", TOKEN_ID)]:
        for path, role in _grants(cfg, facts["media_name"]):
            if not _granted(acls, path, principal, role):
                extra = ["--propagate", "0"] if path == "/" else []
                journal.mutate(["pveum", "acl", "modify", path, flag, principal, "--roles", role, *extra],
                               ["pveum", "acl", "delete", path, flag, principal, "--roles", role])

    sdn_changed = journal.create("/cluster/sdn/zones", "/cluster/sdn/zones/umiak",
                   "--zone", "umiak", "--type", "simple", "--ipam", "pve", "--dhcp", "dnsmasq")
    sdn_changed |= journal.create("/cluster/sdn/vnets", "/cluster/sdn/vnets/umiak0",
                   "--vnet", "umiak0", "--zone", "umiak", "--isolate-ports", "1")
    sdn_changed |= journal.create("/cluster/sdn/vnets/umiak0/subnets", SUBNET,
                   "--subnet", "10.88.0.0/24", "--type", "subnet", "--gateway", "10.88.0.1", "--snat", "1",
                   "--dhcp-range", "start-address=10.88.0.100,end-address=10.88.0.250",
                   "--dhcp-dns-server", str(ipaddress.ip_address(cfg.guest_dns)))
    journal.create("/cluster/firewall/ipset", "/cluster/firewall/ipset/umiak-gateway", "--name", "umiak-gateway")
    ipset = "/cluster/firewall/ipset/umiak-gateway"
    if not any(row.get("cidr") == cfg.gateway_ip for row in get(runner, ipset)):
        journal.mutate(["pvesh", "create", ipset, "--cidr", cfg.gateway_ip, "--comment", "Umiak guest gateway"],
                       ["pvesh", "delete", ipset + "/" + cfg.gateway_ip])
    group = "/cluster/firewall/groups/umiak-egress"
    journal.create("/cluster/firewall/groups", group, "--group", "umiak-egress", "--comment", "Umiak sandbox egress")
    rules = sorted(get(runner, group), key=lambda row: int(row.get("pos", 0)))
    for position, rule in enumerate(EGRESS_RULES):
        if position < len(rules) and _rule_matches(rules[position], rule):
            continue
        args = [part for key, value in rule.items() for part in ["--" + key, str(value)]]
        journal.mutate(["pvesh", "create", group, *args, "--pos", str(position)], ["pvesh", "delete", f"{group}/{position}"])
        rules.insert(position, rule)

    # Only zone/VNet/subnet changes need an SDN apply (firewall objects and
    # access changes are live); a no-op rerun must not reload SDN.
    if sdn_changed:
        try:
            runner.run(["pvesh", "set", "/cluster/sdn"])
        finally:
            rollback.restore_bridge(journal.state, runner.run)


def _verify(runner: Runner, cfg: PrepareConfig, media_name: str) -> None:
    acls = get(runner, "/access/acl")
    for principal in (USER_ID, TOKEN_ID):
        for path, role in _grants(cfg, media_name):
            if not _granted(acls, path, principal, role):
                raise InstallerError(f"Verification failed: {principal} lacks {role} on {path}")
    for path, expected in TOPOLOGY:
        current = get(runner, path)
        if any(str(current.get(key)) != str(value) for key, value in expected.items()):
            raise InstallerError("Verification failed: " + path)
    get(runner, SUBNET)
    if not any(row.get("cidr") == cfg.gateway_ip for row in get(runner, "/cluster/firewall/ipset/umiak-gateway")):
        raise InstallerError("Verification failed: gateway IPSet")
    rules = sorted(get(runner, "/cluster/firewall/groups/umiak-egress"), key=lambda row: int(row.get("pos", 0)))
    if len(rules) < len(EGRESS_RULES) or not all(_rule_matches(r, e) for r, e in zip(rules, EGRESS_RULES, strict=False)):
        raise InstallerError("Verification failed: umiak-egress rules")
    if pending_sdn(runner):
        raise InstallerError("Verification failed: SDN changes are still pending")


def _node_key(runner: Runner, out_dir: Path) -> str:
    key = out_dir / "umiak-node_ed25519"
    pub = out_dir / "umiak-node_ed25519.pub"
    if not key.exists():
        pub.unlink(missing_ok=True)
        runner.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "umiak-node", "-f", str(key)])
    elif not pub.exists():
        write_secret(pub, runner.run(["ssh-keygen", "-y", "-f", str(key)]) + "\n")
    key.chmod(0o600)
    pub.chmod(0o600)
    public_key = " ".join(pub.read_text().split()[:3])
    if not PUBLIC_KEY.fullmatch(public_key):
        raise InstallerError("Generated node-agent key is not an ed25519 public key")
    return public_key


def _node_config(cfg: PrepareConfig, facts: dict) -> str:
    media = facts["media_path"].rstrip("/")
    q = json.dumps
    return (
        f"node = {q(cfg.node)}\n"
        f"vg = {q(facts['storage']['vgname'])}\n"
        f"thinPool = {q(facts['storage']['thinpool'])}\n"
        f"storage = {q(cfg.storage)}\n"
        f"isoDir = {q(media + '/template/iso')}\n"
        f"importDir = {q(media + '/import')}\n"
        f"vmidMin = {cfg.vmid_min}\n"
        f"vmidMax = {cfg.vmid_max}\n"
        f"templateVmidMin = {cfg.tpl_min}\n"
        f"templateVmidMax = {cfg.tpl_max}\n"
        "templateVmid = 0\n"
        'sdnZone = "umiak"\n'
        'vnet = "umiak0"\n'
        "clusterId = 1\n"
    )


def prepare(runner: Runner, cfg: PrepareConfig, out_dir: Path) -> PrepareResult:
    facts = _preflight(runner, cfg)
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = runner.path(STATE_DIR)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (state / rollback.LOCK).open("a")
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallerError("Another host preparation is running") from error
        if (state / rollback.ACTIVE).exists():
            raise InstallerError(
                "A previous preparation was not rolled back completely. Its timer retries in a few minutes; "
                f"to retry now run: {rollback.retry_hint(state)}"
            )
        journal = _Journal(runner, state)
        _arm(runner, state, facts["bridge"])
        keep_timer = False
        try:
            _apply(runner, cfg, facts, out_dir, journal)
            _verify(runner, cfg, facts["media_name"])
            public_key = _node_key(runner, out_dir)
            write_secret(out_dir / "pve-token-id", TOKEN_ID)
            write_secret(out_dir / "pve-root-ca.pem", runner.path("/etc/pve/pve-root-ca.pem").read_text())
            # Pin this node's own host key for both names the control plane may use.
            write_secret(out_dir / "known_hosts", f"{facts['node_ip']},{cfg.node} {facts['host_key']}\n")
            write_secret(state / STAGED_NODE_CONFIG, _node_config(cfg, facts))
            (state / rollback.ACTIVE).unlink()
        except BaseException:
            try:
                rollback.replay(state, runner.run)
            except Exception:  # noqa: BLE001 - surface the original error
                # Leave the timer armed: it retries the rollback from the journal.
                keep_timer = True
                print("Rollback incomplete; retry with: " + rollback.retry_hint(state), file=sys.stderr)
            raise
        finally:
            if not keep_timer:
                _stop_timer(runner)
    finally:
        lock.close()
    return PrepareResult(
        token_id=TOKEN_ID,
        media_storage=facts["media_name"],
        node_ip=facts["node_ip"],
        public_key=public_key,
        files={name: out_dir / name for name in SECRET_FILES},
    )


def _snapshot(path: Path):
    return (path.read_bytes(), path.stat().st_mode & 0o777) if path.exists() else None


def _restore(path: Path, saved) -> None:
    if saved is None:
        path.unlink(missing_ok=True)
    else:
        _replace(path, saved[0], saved[1])


def _replace(path: Path, data: bytes, mode: int | None) -> None:
    # Write next to the target and rename: never truncate a running binary or
    # leave a half-written file. mode=None for pmxcfs (fixed permissions).
    tmp = path.with_name("." + path.name + ".umiak-new")
    try:
        tmp.write_bytes(data)
        if mode is not None:
            tmp.chmod(mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _remove_key_line(keys: Path, line: str) -> None:
    # Re-read: other nodes may have changed the cluster-wide file meanwhile
    # (same unavoidable read+rename race as in install_node_agent).
    content = keys.read_text() if keys.exists() else ""
    lines = content.splitlines()
    if line in lines:
        kept = [item for item in lines if item != line]
        _replace(keys, ("\n".join(kept) + "\n" if kept else "").encode(), None)


def install_node_agent(runner: Runner, binary: Path, sha256: str, public_key: str) -> None:
    """Install the restricted node-agent on this node after prepare().

    Verifies the binary's SHA256 before any write, installs it with the config
    staged by prepare(), adds the forced-command key line to the cluster-wide
    authorized_keys (other lines untouched) and probes the agent. On failure
    the previous files are restored.
    """
    staged = runner.path(STATE_DIR) / STAGED_NODE_CONFIG
    if not staged.exists():
        raise InstallerError("Run prepare() before installing the node-agent (no staged node configuration)")
    public_key = " ".join(public_key.split())
    if not PUBLIC_KEY.fullmatch(public_key):
        raise InstallerError("Invalid node-agent public key")
    data = Path(binary).read_bytes()
    if not re.fullmatch(r"[0-9a-f]{64}", sha256 or "") or hashlib.sha256(data).hexdigest() != sha256:
        raise InstallerError("Node-agent checksum mismatch")
    target, config, keys = runner.path(NODE_BINARY), runner.path(NODE_CONFIG), runner.path(AUTHORIZED_KEYS)
    saved = {path: _snapshot(path) for path in (target, config)}
    line = f'restrict,command="{NODE_BINARY} --stdio" {public_key}'
    added_line = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        _replace(target, data, 0o755)
        _replace(config, staged.read_bytes(), 0o644)
        # /etc/pve/priv/authorized_keys is cluster-wide root SSH access: append
        # only our line, atomically (pmxcfs supports rename), never rewrite others.
        content = keys.read_text() if keys.exists() else ""
        # Unavoidable race: pmxcfs offers no lock we can hold here, so another
        # node may rewrite this file between our read and rename and one of the
        # two changes can be lost. We keep the window to one read+rename and
        # only ever add (or, on failure, remove) our own line.
        if line not in content.splitlines():
            _replace(keys, (content + ("" if not content or content.endswith("\n") else "\n") + line + "\n").encode(), None)
            added_line = True
        probe = runner.run([str(target), "--stdio"], input=json.dumps({"op": "version", "args": {}}))
        if not json.loads(probe).get("ok"):
            raise InstallerError("Node-agent verification failed")
    except BaseException:
        undo = [(path, lambda p=path, prev=previous: _restore(p, prev)) for path, previous in saved.items()]
        if added_line:
            undo.append((keys, lambda: _remove_key_line(keys, line)))
        for path, action in undo:
            try:
                action()
            except Exception as error:  # noqa: BLE001 - restore the rest, keep the original error
                print(f"Could not restore {path}: {error}", file=sys.stderr)
        raise
