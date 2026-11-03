# Read-only host verification for existing least-privilege Umiak installations.
import base64
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import urllib.request

config = json.loads(base64.b64decode(sys.argv[1]))
if "--dry-run" in sys.argv[2:]:
    print("DRY RUN: read-only verification of user/token, role, pool, SDN, IPSet, firewall and node-agent; callback not sent")
    sys.exit(0)
if os.geteuid() != 0 or socket.gethostname().split(".")[0] != config["node"]:
    raise SystemExit("Run as root on the PVE node named in Setup")


def get(path, *options):
    return json.loads(subprocess.run(["pvesh", "get", path, *options, "--output-format", "json"], text=True, capture_output=True, check=True).stdout)


def optional_set(name):
    try:
        return get("/cluster/firewall/ipset/" + name)
    except subprocess.CalledProcessError:
        return []


# Read staged changes explicitly: default PVE SDN reads omit pending metadata.
vnets = get("/cluster/sdn/vnets", "--pending", "1")
for path in ["/cluster/sdn/zones", "/cluster/sdn/vnets", *["/cluster/sdn/vnets/" + row["vnet"] + "/subnets" for row in vnets]]:
    if any(row.get("pending") or row.get("state") in ["new", "changed", "deleted"] for row in get(path, "--pending", "1")):
        raise SystemExit("Pending SDN changes must be applied or reverted by the administrator before adoption")

uid, token = config["tokenId"].split("!")
report = {
    "user": get("/access/users/" + uid),
    "token": get("/access/users/" + uid + "/token/" + token),
    "role": get("/access/roles/UmiakPoC"),
    "downloadPrivileges": {"requiredNodePrivilege": "Sys.AccessNetwork", "requiredStoragePrivilege": "Datastore.AllocateTemplate", "acl": get("/access/acl")},
    "pool": get("/pools/umiak"),
    "zone": get("/cluster/sdn/zones/umiak", "--pending", "1"),
    "vnet": get("/cluster/sdn/vnets/umiak0", "--pending", "1"),
    "ipset": get("/cluster/firewall/ipset/umiak-gateway"),
    "rules": get("/cluster/firewall/groups/umiak-egress"),
    "denySets": {name: optional_set(name) for name in ["umiak-deny", "umiak-deny6", "umiak-deny-public"]},
    "firewall": get("/cluster/firewall/options"),
}
report["nodeFirewall"] = get("/nodes/" + config["node"] + "/firewall/options")
# Host-rule enable is informational; sandbox VM and NIC enable control isolation.
# Sealed templates have their build firewall removed; Machines.create installs it.
report["vmFirewallsValid"] = True
for vm in get("/nodes/" + config["node"] + "/qemu"):
    vmid = int(vm["vmid"])
    if not (500 <= vmid <= 589) or int(vm.get("template", 0)) == 1:
        continue
    vm_config = get(f"/nodes/{config['node']}/qemu/{vmid}/config")
    if not vm.get("name", "").startswith("umiak-") and not any(tag.startswith("umiak") for tag in vm_config.get("tags", "").split(";")):
        continue
    options = get(f"/nodes/{config['node']}/qemu/{vmid}/firewall/options")
    if int(options.get("enable", 0)) != 1:
        report["vmFirewallsValid"] = False
    if options.get("policy_in") != "DROP" or int(options.get("macfilter", 0)) != 1 or int(options.get("ipfilter", 0)) != 1:
        report["vmFirewallsValid"] = False
    rules = get(f"/nodes/{config['node']}/qemu/{vmid}/firewall/rules")
    for key, value in vm_config.items():
        if key.startswith("net") and key[3:].isdigit() and "firewall=1" not in value.split(","):
            report["vmFirewallsValid"] = False
        if key.startswith("net") and key[3:].isdigit() and not any(rule.get("type") == "group" and rule.get("action") == "umiak-egress" and int(rule.get("enable", 0)) == 1 and rule.get("iface", key) == key for rule in rules):
            report["vmFirewallsValid"] = False
node = subprocess.run(["/usr/local/bin/umiak-node", "--stdio"], input=json.dumps({"op": "version", "args": {}}), text=True, capture_output=True, check=True)
report["nodeAgent"] = json.loads(node.stdout)
ca = Path(config.get("caPath", "/etc/ssl/certs/ca-certificates.crt"))
context = None
if config["origin"].startswith("https://"):
    if not ca.exists():
        raise SystemExit("HTTPS proxy trust store is missing: " + str(ca))
    context = ssl.create_default_context(cafile=str(ca))
request = urllib.request.Request(config["origin"] + "/quickstart/setup/callback", data=json.dumps({"token": config["token"], "report": report, "caPem": Path("/etc/pve/pve-root-ca.pem").read_text()}).encode(), headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    if response.status != 200:
        raise SystemExit("Read-only adoption callback failed")
print("Read-only host report accepted. Click Adopt in the owner dashboard.")
