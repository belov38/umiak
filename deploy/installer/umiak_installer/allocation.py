"""Read-only cluster allocation, before prerequisites can mutate the host."""

import ipaddress
import json

from .pve import InstallerError, get

DEFAULT_SUBNET = "10.88.0.0/24"


def free_block(start, size, occupied, excluded=()):
    low = start
    while low + size - 1 <= 999_999_999:
        high = low + size - 1
        conflicts = [v for v in occupied if low <= v <= high]
        conflicts.extend(b for a, b in excluded if low <= b and a <= high)
        if not conflicts:
            return low, high
        low = max(conflicts) + 1
    raise InstallerError("No free VMID block available")


def local_networks(runner):
    return {
        "addresses": json.loads(runner.run(["ip", "-j", "-4", "address", "show"])),
        "routes": json.loads(runner.run(["ip", "-j", "-4", "route", "show", "table", "all"])),
    }


def occupied_networks(runner, *, resume=False):
    from .nodes import HostConsole
    networks = []
    members = get(runner, "/cluster/status")
    names = {runner.hostname()} | {r["name"] for r in members if r.get("type") == "node" and r.get("online")}
    for node in sorted(names):
        facts = local_networks(runner) if node == runner.hostname() else HostConsole(runner).call(node, "networks")
        for row in facts["addresses"]:
            if resume and row.get("ifname") == "umiak0":
                continue
            for addr in row.get("addr_info", []):
                if addr.get("local"):
                    networks.append(ipaddress.IPv4Network(f"{addr['local']}/{addr['prefixlen']}", strict=False))
        for row in facts["routes"]:
            if row.get("dst", "default") == "default" or (resume and row.get("dev") == "umiak0"):
                continue
            networks.append(ipaddress.IPv4Network(row["dst"], strict=False))
    for vnet in get(runner, "/cluster/sdn/vnets"):
        for row in get(runner, f"/cluster/sdn/vnets/{vnet['vnet']}/subnets"):
            if resume and vnet["vnet"] == "umiak0":
                continue
            value = row.get("cidr") or row.get("subnet")
            if "/" not in str(value):
                value = get(runner, f"/cluster/sdn/vnets/{vnet['vnet']}/subnets/{value}")["subnet"]
            networks.append(ipaddress.IPv4Network(value, strict=False))
    return networks


def subnet_candidates():
    # Prefer adjacent second octets, then the remaining RFC1918 /24s.
    for space in ("10.88.0.0/13", "10.96.0.0/11", "10.128.0.0/9", "10.0.0.0/10",
                  "10.64.0.0/12", "10.80.0.0/13", "172.16.0.0/12", "192.168.0.0/16"):
        net = ipaddress.IPv4Network(space)
        # Try x.y.0.0 before x.y.1.0, etc.
        blocks = list(net.subnets(new_prefix=24))
        yield from sorted(blocks, key=lambda n: (int(n.network_address) & 0xff00, int(n.network_address)))


def choose_subnet(occupied):
    return next((str(n) for n in subnet_candidates() if not any(n.overlaps(o) for o in occupied)), None)


def subnet_path(subnet=DEFAULT_SUBNET):
    return "/cluster/sdn/vnets/umiak0/subnets/umiak-" + subnet.replace("/", "-")
