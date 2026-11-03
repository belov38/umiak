"""Read-only host report for the control plane's bootstrap import.

The JSON shape is consumed by deploy/compose/quickstart/bootstrap.mjs
(verifyIsolation(report.rules, report.ipset, gateway, report.denySets) plus
user/zone/vnet/firewall/vmFirewallsValid checks); keep it stable.
"""

import json
from pathlib import Path

from .prepare_host import NODE_BINARY, TOKEN_NAME, USER_ID
from .pve import CommandError, InstallerError, Runner, get, pending_sdn, write_secret

DENY_SETS = ["umiak-deny", "umiak-deny6", "umiak-deny-public"]


def _optional_set(runner: Runner, name: str):
    try:
        return get(runner, "/cluster/firewall/ipset/" + name)
    except CommandError:
        return []


def _vm_firewalls_valid(runner: Runner, node: str, vmid_min: int, vmid_max: int) -> bool:
    # Host-rule enable is informational; sandbox VM and NIC enable control isolation.
    # Sealed templates have their build firewall removed; Machines.create installs it.
    valid = True
    for vm in get(runner, f"/nodes/{node}/qemu"):
        vmid = int(vm["vmid"])
        if not (vmid_min <= vmid <= vmid_max) or int(vm.get("template", 0)) == 1:
            continue
        config = get(runner, f"/nodes/{node}/qemu/{vmid}/config")
        tags = str(config.get("tags", "")).split(";")
        if not str(vm.get("name", "")).startswith("umiak-") and not any(tag.startswith("umiak") for tag in tags):
            continue
        options = get(runner, f"/nodes/{node}/qemu/{vmid}/firewall/options")
        if int(options.get("enable", 0)) != 1:
            valid = False
        if options.get("policy_in") != "DROP" or int(options.get("macfilter", 0)) != 1 or int(options.get("ipfilter", 0)) != 1:
            valid = False
        rules = get(runner, f"/nodes/{node}/qemu/{vmid}/firewall/rules")
        for key, value in config.items():
            if not (key.startswith("net") and key[3:].isdigit()):
                continue
            if "firewall=1" not in str(value).split(","):
                valid = False
            if not any(
                rule.get("type") == "group" and rule.get("action") == "umiak-egress"
                and int(rule.get("enable", 0)) == 1 and rule.get("iface", key) == key
                for rule in rules
            ):
                valid = False
    return valid


def collect(runner: Runner, node: str, vmid_min: int = 500, vmid_max: int = 589) -> dict:
    if pending_sdn(runner):
        raise InstallerError("Pending SDN changes must be applied or reverted by the administrator first")
    report = {
        "user": get(runner, "/access/users/" + USER_ID),
        "token": get(runner, f"/access/users/{USER_ID}/token/{TOKEN_NAME}"),
        "role": get(runner, "/access/roles/UmiakPoC"),
        "downloadPrivileges": {
            "requiredNodePrivilege": "Sys.AccessNetwork",
            "requiredStoragePrivilege": "Datastore.AllocateTemplate",
            "acl": get(runner, "/access/acl"),
        },
        "pool": get(runner, "/pools/umiak"),
        "zone": get(runner, "/cluster/sdn/zones/umiak", "--pending", "1"),
        "vnet": get(runner, "/cluster/sdn/vnets/umiak0", "--pending", "1"),
        "ipset": get(runner, "/cluster/firewall/ipset/umiak-gateway"),
        "rules": get(runner, "/cluster/firewall/groups/umiak-egress"),
        "denySets": {name: _optional_set(runner, name) for name in DENY_SETS},
        "firewall": get(runner, "/cluster/firewall/options"),
        "nodeFirewall": get(runner, f"/nodes/{node}/firewall/options"),
        "vmFirewallsValid": _vm_firewalls_valid(runner, node, vmid_min, vmid_max),
    }
    probe = runner.run([str(runner.path(NODE_BINARY)), "--stdio"], input=json.dumps({"op": "version", "args": {}}))
    report["nodeAgent"] = json.loads(probe)
    return report


def write(report: dict, out_dir: Path) -> Path:
    path = Path(out_dir) / "host-report.json"
    write_secret(path, json.dumps(report, indent=2, sort_keys=True) + "\n")
    return path
