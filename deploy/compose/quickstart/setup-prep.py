# Fresh Proxmox preparation, embedded into the one-time setup script.
# No shell interpolation: commands are argv lists. Existing managed objects are
# verified/adopted; the prepared dev stand uses only read-only wizard adoption.
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import urllib.request
import ssl

config = json.loads(base64.b64decode(sys.argv[1]))
user_id, token_name = config.get("tokenId", "umiak@pve!dev").split("!")
dry = "--dry-run" in sys.argv[2:]
plan = [
    "Verify Proxmox prerequisites and existing Umiak objects",
    "Create/adopt umiak@pve, UmiakPoC role, dev token and umiak pool",
    "Create/adopt restricted node-agent SSH key, pinned host key and configuration",
    "Arm automatic rollback before scoped Umiak SDN/firewall changes",
    "Create/adopt umiak zone, umiak0 VNet, 10.88.0.0/24 subnet and DHCP/SNAT",
    "Create/adopt umiak-gateway IPSet and umiak-egress security group",
    "Verify host state and report credentials via one-time HTTPS callback",
    "Cancel rollback only after callback and verification succeed",
]
if dry:
    print("DRY RUN: no commands executed, no files written, no callback sent")
    for item in plan:
        print(item)
    sys.exit(0)
if os.geteuid() != 0:
    raise SystemExit("Run this script as root on the intended Proxmox node")
if socket.gethostname().split(".")[0] != config["node"]:
    raise SystemExit("Node name does not match the wizard; refusing to prepare another host")
for executable in ["pvesh", "pveum", "openssl", "ssh-keygen", "systemd-run", "ifquery"]:
    subprocess.run(["which", executable], check=True, stdout=subprocess.DEVNULL)


def command(*args, capture=True):
    result = subprocess.run(args, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


def get(path):
    return json.loads(command("pvesh", "get", path, "--output-format", "json"))


def exists(path):
    try:
        get(path)
        return True
    except subprocess.CalledProcessError:
        return False


# A fresh preparation may create only absent networking objects. Conflicting
# existing topology must be resolved in the wizard, never overwritten here.
if exists("/cluster/sdn/zones/umiak"):
    raise SystemExit("Existing Umiak SDN found: use read-only Adopt in the dashboard")
if "[fail]" in subprocess.run(["ifquery", "--check", "-a"], capture_output=True, text=True).stdout:
    raise SystemExit("Host network configuration differs from live state; refusing SDN apply")
if not Path("/usr/sbin/dnsmasq").exists():
    raise SystemExit("Install dnsmasq and dnsmasq-utils with its system service disabled before preparation")
if command("sysctl", "-n", "net.ipv4.ip_forward") != "1":
    raise SystemExit("Enable IPv4 forwarding for Proxmox SDN before preparation")

bridge_hash_file = Path("/sys/class/net/vmbr0/bridge/mcast_hash_max")
bridge_hash = bridge_hash_file.read_text().strip() if bridge_hash_file.exists() else None


def restore_bridge():
    # Proxmox SDN reload may reset ifupdown2's multicast hash default.
    # Restore only a value changed by our apply; never rewrite bridge config.
    if bridge_hash and bridge_hash_file.read_text().strip() != bridge_hash:
        command("ip", "link", "set", "dev", "vmbr0", "type", "bridge", "mcast_hash_max", bridge_hash)


def apply_sdn():
    try:
        command("pvesh", "set", "/cluster/sdn")
    finally:
        restore_bridge()


state = Path("/var/lib/umiak-quickstart")
state.mkdir(mode=0o700, exist_ok=True)
rollback = state / "rollback.sh"
# Only objects created in this invocation are removed by the rollback timer.
undo = ["#!/bin/sh", "set -u"]


def save_undo():
    finish = ["pvesh set /cluster/sdn"]
    if bridge_hash:
        finish.append("ip link set dev vmbr0 type bridge mcast_hash_max " + shlex.quote(bridge_hash))
    rollback.write_text("\n".join(undo + finish) + "\n")
    rollback.chmod(0o700)


def create(path, delete_path, *args):
    command("pvesh", "create", path, *args)
    undo.insert(2, "pvesh delete " + shlex.quote(delete_path) + " || true")
    save_undo()


save_undo()
command("systemd-run", "--quiet", "--unit=umiak-quickstart-rollback", "--on-active=5min", str(rollback))
privs = "VM.Allocate VM.Audit VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt VM.GuestAgent.Audit VM.GuestAgent.FileRead VM.GuestAgent.FileWrite VM.GuestAgent.FileSystemMgmt VM.GuestAgent.Unrestricted Pool.Audit"
roles = json.loads(command("pveum", "role", "list", "--output-format", "json"))
if not any(x["roleid"] == "UmiakPoC" for x in roles):
    command("pveum", "role", "add", "UmiakPoC", "--privs", privs)
if not exists("/pools/umiak"):
    command("pveum", "pool", "add", "umiak", "--comment", "Umiak quickstart")
users = json.loads(command("pveum", "user", "list", "--output-format", "json"))
if not any(x["userid"] == user_id for x in users):
    command("pveum", "user", "add", user_id, "--comment", "Umiak quickstart")
token_path = state / "pve-token"
tokens = json.loads(command("pveum", "user", "token", "list", user_id, "--output-format", "json"))
if any(x["tokenid"] == token_name for x in tokens) and not token_path.exists():
    raise SystemExit("Existing API token secret is unavailable: use read-only adoption with the existing secret")
if not token_path.exists():
    token = json.loads(command("pveum", "user", "token", "add", user_id, token_name, "--privsep", "1", "--output-format", "json"))["value"]
    token_path.write_text(token)
    token_path.chmod(0o600)
for role, privileges in [("UmiakTemplateMedia", "Datastore.AllocateTemplate Datastore.Audit"), ("UmiakConsole", "VM.Console")]:
    if not any(x["roleid"] == role for x in roles):
        command("pveum", "role", "add", role, "--privs", privileges)
for principal_flag, principal in [("--users", user_id), ("--tokens", user_id + "!" + token_name)]:
    for path, role in [("/pool/umiak", "UmiakPoC"), ("/storage/local-lvm", "PVEDatastoreUser"), ("/sdn/zones/umiak", "PVESDNUser"), ("/storage/local", "UmiakTemplateMedia"), ("/pool/umiak", "UmiakConsole")]:
        command("pveum", "acl", "modify", path, principal_flag, principal, "--roles", role)

create("/cluster/sdn/zones", "/cluster/sdn/zones/umiak", "--zone", "umiak", "--type", "simple", "--ipam", "pve", "--dhcp", "dnsmasq")
create("/cluster/sdn/vnets", "/cluster/sdn/vnets/umiak0", "--vnet", "umiak0", "--zone", "umiak", "--isolate-ports", "1")
create("/cluster/sdn/vnets/umiak0/subnets", "/cluster/sdn/vnets/umiak0/subnets/umiak-10.88.0.0-24", "--subnet", "10.88.0.0/24", "--type", "subnet", "--gateway", "10.88.0.1", "--snat", "1", "--dhcp-range", "start-address=10.88.0.100,end-address=10.88.0.250", "--dhcp-dns-server", "1.1.1.1")
if not exists("/cluster/firewall/ipset/umiak-gateway"):
    create("/cluster/firewall/ipset", "/cluster/firewall/ipset/umiak-gateway", "--name", "umiak-gateway")
command("pvesh", "create", "/cluster/firewall/ipset/umiak-gateway", "--cidr", config["gateway"], "--comment", "Umiak guest gateway")
if not exists("/cluster/firewall/groups/umiak-egress"):
    create("/cluster/firewall/groups", "/cluster/firewall/groups/umiak-egress", "--group", "umiak-egress", "--comment", "Umiak sandbox egress")
    for rule in reversed([
        ["--type", "out", "--action", "ACCEPT", "--proto", "tcp", "--dport", "443", "--dest", "+umiak-gateway"],
        ["--type", "out", "--action", "DROP", "--dest", "10.0.0.0/8"],
        ["--type", "out", "--action", "DROP", "--dest", "172.16.0.0/12"],
        ["--type", "out", "--action", "DROP", "--dest", "192.168.0.0/16"],
        ["--type", "out", "--action", "DROP", "--dest", "100.64.0.0/10"],
        ["--type", "out", "--action", "DROP", "--dest", "169.254.0.0/16"],
        ["--type", "out", "--action", "DROP", "--dest", "224.0.0.0/4"],
        ["--type", "out", "--action", "DROP", "--dest", "::/1"],
        ["--type", "out", "--action", "DROP", "--dest", "8000::/1"],
    ]):
        command("pvesh", "create", "/cluster/firewall/groups/umiak-egress", *rule, "--enable", "1", "--pos", "0")
# Do not enable the cluster firewall globally: an existing host policy may block
# management. An operator must enable/verify it before this fresh path can proceed.
if not get("/cluster/firewall/options").get("enable"):
    raise SystemExit("Cluster firewall must already be enabled and verified; rollback timer remains armed")
apply_sdn()

ca = Path(config.get("caPath", "/root/.config/umiak/quickstart-ca.pem"))
if not ca.exists():
    raise SystemExit("Copy the verified quickstart CA to " + str(ca) + "; rollback timer remains armed")
context = ssl.create_default_context(cafile=str(ca))
binary = urllib.request.urlopen(config["origin"] + "/downloads/umiak-node-linux-amd64", context=context, timeout=30).read()
expected = config.get("nodeSha256")
if not expected or hashlib.sha256(binary).hexdigest() != expected:
    raise SystemExit("Node-agent checksum mismatch or unavailable manifest")
node_binary = Path("/usr/local/bin/umiak-node")
node_binary.write_bytes(binary)
node_binary.chmod(0o755)
node_config = f'''node = "{config['node']}"
vg = "pve"
thinPool = "data"
storage = "local-lvm"
vmidMin = 500
vmidMax = 589
templateVmidMin = 595
templateVmidMax = 599
templateVmid = 599
sdnZone = "umiak"
vnet = "umiak0"
clusterId = 1
'''
Path("/etc/umiak-node.toml").write_text(node_config)
line = 'restrict,command="/usr/local/bin/umiak-node --stdio" ' + config["publicKey"]
authorized = Path("/etc/pve/priv/authorized_keys")
content = authorized.read_text() if authorized.exists() else ""
if line not in content.splitlines():
    authorized.write_text(content.rstrip() + "\n" + line + "\n")
probe = subprocess.run([str(node_binary), "--stdio"], input=json.dumps({"op": "version", "args": {}}), text=True, capture_output=True, check=True)
if not json.loads(probe.stdout).get("ok"):
    raise SystemExit("Node-agent verification failed; rollback timer remains armed")
host_key = Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text().split()
report = {"token": config["token"], "tokenSecret": token_path.read_text().strip(), "caPem": Path("/etc/pve/pve-root-ca.pem").read_text(), "sshPublicKey": " ".join(host_key[:2])}
request = urllib.request.Request(config["origin"] + "/quickstart/setup/callback", data=json.dumps(report).encode(), headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    if response.status != 200:
        raise SystemExit("Callback failed; rollback timer remains armed")
command("systemctl", "stop", "umiak-quickstart-rollback.timer")
print("Host prepared and credentials reported. Re-run Adopt in the owner dashboard.")
