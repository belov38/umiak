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


def get(path):
    return json.loads(subprocess.run(["pvesh", "get", path, "--output-format", "json"], text=True, capture_output=True, check=True).stdout)


def optional_set(name):
    try:
        return get("/cluster/firewall/ipset/" + name)
    except subprocess.CalledProcessError:
        return []


uid, token = config["tokenId"].split("!")
report = {
    "user": get("/access/users/" + uid),
    "token": get("/access/users/" + uid + "/token/" + token),
    "role": get("/access/roles/UmiakPoC"),
    "pool": get("/pools/umiak"),
    "zone": get("/cluster/sdn/zones/umiak"),
    "vnet": get("/cluster/sdn/vnets/umiak0"),
    "ipset": get("/cluster/firewall/ipset/umiak-gateway"),
    "rules": get("/cluster/firewall/groups/umiak-egress"),
    "denySets": {name: optional_set(name) for name in ["umiak-deny", "umiak-deny6", "umiak-deny-public"]},
    "firewall": get("/cluster/firewall/options"),
}
report["nodeFirewall"] = get("/nodes/" + config["node"] + "/firewall/options")
report["vmFirewallsValid"] = True
for vm in get("/nodes/" + config["node"] + "/qemu"):
    vmid = int(vm["vmid"])
    if not (500 <= vmid <= 589 or 595 <= vmid <= 598):
        continue
    vm_config = get(f"/nodes/{config['node']}/qemu/{vmid}/config")
    if not any(tag.startswith("umiak") for tag in vm_config.get("tags", "").split(";")):
        continue
    options = get(f"/nodes/{config['node']}/qemu/{vmid}/firewall/options")
    if int(options.get("enable", 0)) != 1:
        report["vmFirewallsValid"] = False
    for key, value in vm_config.items():
        if key.startswith("net") and key[3:].isdigit() and "firewall=1" not in value.split(","):
            report["vmFirewallsValid"] = False
node = subprocess.run(["/usr/local/bin/umiak-node", "--stdio"], input=json.dumps({"op": "version", "args": {}}), text=True, capture_output=True, check=True)
report["nodeAgent"] = json.loads(node.stdout)
ca = Path(config.get("caPath", "/root/.config/umiak/quickstart-ca.pem"))
if not ca.exists():
    raise SystemExit("Copy the verified quickstart CA to " + str(ca))
context = ssl.create_default_context(cafile=str(ca))
request = urllib.request.Request(config["origin"] + "/quickstart/setup/callback", data=json.dumps({"token": config["token"], "report": report, "caPem": Path("/etc/pve/pve-root-ca.pem").read_text()}).encode(), headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    if response.status != 200:
        raise SystemExit("Read-only adoption callback failed")
print("Read-only host report accepted. Click Adopt in the owner dashboard.")
