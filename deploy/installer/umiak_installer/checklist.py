"""Read-only prerequisite checklist. Each gap carries the exact fix to confirm.

inspect() never changes the host; apply_fix() runs one fix the user confirmed.
"""

import sys
from dataclasses import dataclass, field

from .ct import have_arping
from .prepare_host import dnsmasq_service_enabled
from .pve import CommandError, Runner, get, lvmthin_storages, media_storages, pending_sdn

DEFAULT_RANGES = ((500, 589), (600, 699))


@dataclass(frozen=True)
class Fix:
    description: str
    commands: list[list[str]]
    # Host path -> exact content, written before the commands run.
    files: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    fix: Fix | None
    detail: str


DNSMASQ_FIX = Fix(
    "Install dnsmasq for SDN DHCP and disable its system-wide service (Proxmox SDN runs its own instances)",
    [["apt-get", "install", "-y", "dnsmasq", "dnsmasq-utils"], ["systemctl", "disable", "--now", "dnsmasq"]],
)
DNSMASQ_SERVICE_FIX = Fix(
    "Disable the system-wide dnsmasq service (Proxmox SDN runs its own instances)",
    [["systemctl", "disable", "--now", "dnsmasq"]],
)
ARPING_FIX = Fix(
    "Install iputils-arping (ARP check that the control-plane IP is not already used on the LAN)",
    [["apt-get", "install", "-y", "iputils-arping"]],
)
FORWARD_FIX = Fix(
    "Enable IPv4 forwarding persistently for SDN SNAT (/etc/sysctl.d/99-umiak.conf)",
    [["sysctl", "--system"]],
    {"/etc/sysctl.d/99-umiak.conf": "net.ipv4.ip_forward = 1\n"},
)
FIREWALL_FIX = Fix(
    "Enable the cluster firewall. Warning: this activates host firewall rules on all nodes of the cluster; "
    "check that your datacenter rules (or the PVE defaults) still allow SSH and the web UI (8006) from your management network",
    [["pvesh", "set", "/cluster/firewall/options", "--enable", "1"]],
)


def _check(name, ok, detail, fix=None):
    return Check(name, bool(ok), None if ok else fix, detail)


def _safe(name, probe):
    try:
        return probe()
    except (CommandError, ValueError, KeyError, TypeError) as error:
        return _check(name, False, f"could not be checked: {error}")


def _version(runner):
    version = str(get(runner, "/version").get("version", ""))
    return _check("pve-version", version.split(".")[0] == "9", f"Proxmox VE {version or 'unknown'} (9.x required)")


def _quorum(runner, node):
    status = get(runner, "/cluster/status")
    cluster = next((row for row in status if row.get("type") == "cluster"), None)
    nodes = [row.get("name") for row in status if row.get("type") == "node"]
    if node not in nodes:
        return _check("cluster-quorum", False, f"node {node} is not listed in cluster status")
    if cluster is None:
        return _check("cluster-quorum", True, f"standalone node {node}")
    return _check(
        "cluster-quorum", int(cluster.get("quorate", 0)) == 1,
        f"cluster {cluster.get('name')} with nodes {', '.join(sorted(nodes))}",
    )


def _lvmthin(runner, node, storage):
    names = [row["storage"] for row in lvmthin_storages(runner, node)]
    ok = storage in names if storage else bool(names)
    return _check("lvmthin-storage", ok, "LVM-thin storages: " + (", ".join(names) or "none"))


def _media(runner, node):
    names = [row["storage"] for row in media_storages(runner, node)]
    return _check("media-storage", bool(names), "directory storages with iso,import: " + (", ".join(names) or "none"))


def _dnsmasq(runner):
    if not runner.path("/usr/sbin/dnsmasq").exists():
        return _check("dnsmasq", False, "dnsmasq missing", DNSMASQ_FIX)
    enabled = dnsmasq_service_enabled(runner)
    detail = "dnsmasq present, system service " + ("enabled" if enabled else "disabled")
    return _check("dnsmasq", not enabled, detail, DNSMASQ_SERVICE_FIX)


def _arping(runner):
    present = have_arping(runner)
    return _check("arping", present, "arping " + ("present" if present else "missing"), ARPING_FIX)


def _forward(runner):
    value = runner.run(["sysctl", "-n", "net.ipv4.ip_forward"])
    return _check("ip-forward", value == "1", f"net.ipv4.ip_forward = {value}", FORWARD_FIX)


def _firewall(runner):
    enabled = int(get(runner, "/cluster/firewall/options").get("enable", 0)) == 1
    return _check("cluster-firewall", enabled, "cluster firewall " + ("enabled" if enabled else "disabled"), FIREWALL_FIX)


def _pending(runner):
    pending = pending_sdn(runner)
    return _check(
        "sdn-pending", not pending,
        "pending SDN changes must be applied or reverted by the administrator first" if pending else "no pending SDN changes",
    )


CUSTOM_CERT_MESSAGE = (
    "This node serves a custom certificate (pveproxy-ssl.pem). Umiak 0.1 needs the default Proxmox "
    "certificate on port 8006; custom/ACME certificates are not supported yet."
)


def _pveproxy_cert(runner, node):
    # Ruling R9: the worker trusts only pve-root-ca; an own or ACME certificate is refused.
    custom = runner.path(f"/etc/pve/nodes/{node}/pveproxy-ssl.pem").exists()
    return _check(
        "pveproxy-cert", not custom,
        CUSTOM_CERT_MESSAGE if custom else "default Proxmox certificate on port 8006",
    )


def _is_umiak(guest):
    tags = str(guest.get("tags", "")).replace(",", ";").split(";")
    return str(guest.get("name", "")).startswith("umiak-") or any(tag.startswith("umiak") for tag in tags)


def _vmids(runner, ranges):
    taken = sorted(
        int(guest["vmid"]) for guest in get(runner, "/cluster/resources", "--type", "vm")
        if any(low <= int(guest["vmid"]) <= high for low, high in ranges) and not _is_umiak(guest)
    )
    spans = ", ".join(f"{low}-{high}" for low, high in ranges)
    detail = f"VMIDs {spans} free" if not taken else f"VMIDs in {spans} used by other guests: {', '.join(map(str, taken))}"
    return _check("free-vmids", not taken, detail)


def inspect(runner: Runner, node: str | None = None, storage: str | None = None, ranges=DEFAULT_RANGES) -> list[Check]:
    node = node or runner.hostname()
    python_ok = sys.version_info >= (3, 11)
    return [
        _check("root", runner.euid() == 0, "running as root" if runner.euid() == 0 else "run the installer as root"),
        _safe("pve-version", lambda: _version(runner)),
        _safe("cluster-quorum", lambda: _quorum(runner, node)),
        _check("python", python_ok, "Python " + ".".join(map(str, sys.version_info[:3]))),
        _safe("lvmthin-storage", lambda: _lvmthin(runner, node, storage)),
        _safe("media-storage", lambda: _media(runner, node)),
        _safe("dnsmasq", lambda: _dnsmasq(runner)),
        _safe("arping", lambda: _arping(runner)),
        _safe("ip-forward", lambda: _forward(runner)),
        _safe("cluster-firewall", lambda: _firewall(runner)),
        _safe("sdn-pending", lambda: _pending(runner)),
        _safe("free-vmids", lambda: _vmids(runner, ranges)),
        _safe("pveproxy-cert", lambda: _pveproxy_cert(runner, node)),
    ]


def apply_fix(runner: Runner, fix: Fix) -> None:
    for name, content in fix.files.items():
        path = runner.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o644)
    for argv in fix.commands:
        runner.run(argv)
