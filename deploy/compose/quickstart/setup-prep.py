# Fresh Proxmox preparation, embedded into the one-time setup script.
# No shell interpolation: commands are argv lists. Existing managed objects are
# verified/adopted; the prepared dev stand uses only read-only wizard adoption.
import atexit
import fcntl
import ipaddress
import base64
import hashlib
import json
import os
import re
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


# Complete prerequisite checks precede every mutation, including credentials.
if "[fail]" in subprocess.run(["ifquery", "--check", "-a"], capture_output=True, text=True).stdout:
    raise SystemExit("Host network configuration differs from live state; refusing SDN apply")
if not Path("/usr/sbin/dnsmasq").exists():
    raise SystemExit("Install dnsmasq and dnsmasq-utils with its system service disabled before preparation")
if command("sysctl", "-n", "net.ipv4.ip_forward") != "1":
    raise SystemExit("Enable IPv4 forwarding for Proxmox SDN before preparation")
if int(get("/cluster/firewall/options").get("enable", 0)) != 1:
    raise SystemExit("Cluster firewall must already be enabled and verified")
# Read host-rule options without changing them: they do not gate VM isolation.
node_firewall = get(f"/nodes/{config['node']}/firewall/options")
# Applying SDN commits all pending changes, so refuse any unrelated transaction.
vnets = get("/cluster/sdn/vnets")
for path in ["/cluster/sdn/zones", "/cluster/sdn/vnets", *["/cluster/sdn/vnets/" + row["vnet"] + "/subnets" for row in vnets]]:
    if any(row.get("pending") or row.get("state") in ["new", "changed", "deleted"] for row in get(path)):
        raise SystemExit("Pending SDN changes must be applied or reverted by the administrator first")
for path, expected in [
    ("/cluster/sdn/zones/umiak", {"type": "simple", "ipam": "pve", "dhcp": "dnsmasq"}),
    ("/cluster/sdn/vnets/umiak0", {"zone": "umiak", "isolate-ports": 1}),
]:
    if exists(path):
        existing = get(path)
        if any(str(existing.get(key)) != str(value) for key, value in expected.items()):
            raise SystemExit("Existing Umiak topology differs; use read-only adoption: " + path)
desired_rules = [
    {"type": "out", "action": "ACCEPT", "proto": "tcp", "dport": "443", "dest": "+umiak-gateway", "enable": 1},
    *[{"type": "out", "action": "DROP", "dest": cidr, "enable": 1} for cidr in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "224.0.0.0/4", "::/1", "8000::/1"]],
]
if exists("/cluster/firewall/groups/umiak-egress"):
    cursor = 0
    for row in sorted(get("/cluster/firewall/groups/umiak-egress"), key=lambda row: int(row.get("pos", 0))):
        while cursor < len(desired_rules) and not all(str(row.get(key, "")) == str(value) for key, value in desired_rules[cursor].items()):
            cursor += 1
        if cursor == len(desired_rules):
            raise SystemExit("Existing Umiak firewall group differs; use read-only adoption")
        cursor += 1
storage_name = config.get("storage", "local-lvm")
if not isinstance(storage_name, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", storage_name):
    raise SystemExit("Invalid storage name")
# Match the media ACL, node-agent paths and template-builder storage to the same
# existing directory storage. Do not assume its administrator chose 'local'.
media_candidates = [row for row in get("/storage") if row.get("type") == "dir"
                    and {"import", "iso"}.issubset(set(row.get("content", "").split(",")))
                    and not row.get("disable")
                    and (not row.get("nodes") or config["node"] in row["nodes"].split(","))]
media_candidates.sort(key=lambda row: (row["storage"] != "local", row["storage"]))
if not media_candidates:
    raise SystemExit("An enabled directory storage with import and iso content is required")
media = media_candidates[0]
media_name = media["storage"]
media_path = media.get("path", "")
if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", media_name) or not media_path.startswith("/"):
    raise SystemExit("Invalid template media storage configuration")
storage = get("/storage/" + storage_name)
if storage.get("type") != "lvmthin" or not storage.get("vgname") or not storage.get("thinpool"):
    raise SystemExit("Selected storage must be an existing LVM-thin storage with VG and thinpool")
guest_dns = str(ipaddress.ip_address(config.get("guestDns", "1.1.1.1")))
ca = Path(config.get("caPath", "/root/.config/umiak/quickstart-ca.pem"))
if not ca.exists():
    raise SystemExit("Copy the verified quickstart CA to " + str(ca))
context = ssl.create_default_context(cafile=str(ca))
binary = urllib.request.urlopen(config["origin"] + "/pve-setup.sh?token=" + config["token"] + "&asset=node-agent", context=context, timeout=30).read()
if not config.get("nodeSha256") or hashlib.sha256(binary).hexdigest() != config["nodeSha256"]:
    raise SystemExit("Node-agent checksum mismatch or unavailable manifest")
roles = json.loads(command("pveum", "role", "list", "--output-format", "json"))
users = json.loads(command("pveum", "user", "list", "--output-format", "json"))
user_exists = any(x["userid"] == user_id for x in users)
tokens = json.loads(command("pveum", "user", "token", "list", user_id, "--output-format", "json")) if user_exists else []
token_path = Path("/var/lib/umiak-quickstart/pve-token")
if any(x["tokenid"] == token_name for x in tokens) and not token_path.exists():
    raise SystemExit("Existing API token secret is unavailable: use read-only adoption with the existing secret")
acls = get("/access/acl")

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
lock = (state / "prepare.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
if (state / "active").exists():
    raise SystemExit("Previous preparation rollback is pending; wait for its timer before retrying")
rollback = state / "rollback.py"
undo_file = state / "undo.json"
active_file = state / "active"
undo = []
# The timer waits for this run's lock and checks a success marker. A slow run
# cannot be rolled back after a successful callback, even if its timer fired.
rollback_program = r'''import base64, fcntl, json, pathlib, subprocess, sys
state = pathlib.Path(sys.argv[1])
with (state / "prepare.lock").open("a") as lock:
 fcntl.flock(lock, fcntl.LOCK_EX)
 if not (state / "active").exists(): sys.exit(0)
 actions = json.loads((state / "undo.json").read_text())
 failed = False
 for action in reversed(actions):
  try:
   if action[0] == "command": subprocess.run(action[1], check=True)
   elif action[0] == "file":
    path = pathlib.Path(action[1])
    if action[2] is None: path.unlink(missing_ok=True)
    else:
     path.write_bytes(base64.b64decode(action[2])); path.chmod(action[3])
   elif action[0] == "collection":
    path = action[1]
    rows = json.loads(subprocess.run(["pvesh","get",path,"--output-format","json"],capture_output=True,text=True,check=True).stdout)
    for row in sorted(rows,key=lambda row:int(row.get("pos",0)),reverse=True):
     subprocess.run(["pvesh","delete",path+"/"+str(row.get("cidr",row.get("pos")))],check=True)
    subprocess.run(["pvesh","delete",path],check=True)
  except (OSError, subprocess.CalledProcessError) as error:
   failed = True
   print("Rollback action failed:", action[0], file=sys.stderr)
 subprocess.run(["pvesh","set","/cluster/sdn"],check=True)
 bridge = BRIDGE_HASH
 if bridge: subprocess.run(["ip","link","set","dev","vmbr0","type","bridge","mcast_hash_max",bridge],check=True)
 if failed: raise SystemExit("Rollback incomplete; inspect failures and retry rollback.py")
 (state / "active").unlink(missing_ok=True)
'''
rollback_program = rollback_program.replace('BRIDGE_HASH', repr(bridge_hash))
rollback.write_text("#!/usr/bin/env python3\n" + rollback_program)
rollback.chmod(0o700)
active_file.write_text("active")

def record(action):
    undo.append(action)
    undo_file.write_text(json.dumps(undo))
    undo_file.chmod(0o600)

def backup(path):
    record(["file", str(path), base64.b64encode(path.read_bytes()).decode() if path.exists() else None, path.stat().st_mode & 0o777 if path.exists() else 0o600])

def mutate(args, reverse):
    record(["command", list(reverse)])
    return command(*args)

def create(path, delete_path, *args):
    if exists(delete_path):
        return False
    record(["collection" if "/firewall/" in delete_path else "command", delete_path if "/firewall/" in delete_path else ["pvesh", "delete", delete_path]])
    command("pvesh", "create", path, *args)
    return True

record(["command", ["true"]])
def rollback_on_exit():
    if active_file.exists():
        fcntl.flock(lock, fcntl.LOCK_UN)
        previous = sys.argv
        try:
            sys.argv = [str(rollback), str(state)]
            exec(compile(rollback_program, str(rollback), "exec"), {"__name__": "__main__"})
        finally:
            sys.argv = previous
    lock.close()
    # The timer may already have fired or been collected. Exit cleanup is quiet.
    subprocess.run(["systemctl", "stop", "umiak-quickstart-rollback.timer"],
                   check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(rollback_on_exit)
command("systemd-run", "--quiet", "--collect", "--unit=umiak-quickstart-rollback", "--on-active=5min", str(rollback), str(state))
privs = "VM.Allocate VM.Audit VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt VM.GuestAgent.Audit VM.GuestAgent.FileRead VM.GuestAgent.FileWrite VM.GuestAgent.FileSystemMgmt VM.GuestAgent.Unrestricted Pool.Audit"
if not any(x["roleid"] == "UmiakPoC" for x in roles):
    mutate(["pveum", "role", "add", "UmiakPoC", "--privs", privs], ["pveum", "role", "delete", "UmiakPoC"])
if not exists("/pools/umiak"):
    mutate(["pveum", "pool", "add", "umiak", "--comment", "Umiak quickstart"], ["pveum", "pool", "delete", "umiak"])
if not any(x["userid"] == user_id for x in users):
    mutate(["pveum", "user", "add", user_id, "--comment", "Umiak quickstart"], ["pveum", "user", "delete", user_id])
if not token_path.exists():
    backup(token_path)
    token = json.loads(mutate(["pveum", "user", "token", "add", user_id, token_name, "--privsep", "1", "--output-format", "json"], ["pveum", "user", "token", "remove", user_id, token_name]))["value"]
    token_path.write_text(token)
    token_path.chmod(0o600)
for role, privileges in [("UmiakTemplateMedia", "Datastore.AllocateTemplate Datastore.Audit"), ("UmiakConsole", "VM.Console")]:
    if not any(x["roleid"] == role for x in roles):
        mutate(["pveum", "role", "add", role, "--privs", privileges], ["pveum", "role", "delete", role])
for principal_flag, principal in [("--users", user_id), ("--tokens", user_id + "!" + token_name)]:
    for path, role in [("/pool/umiak", "UmiakPoC"), ("/storage/" + storage_name, "PVEDatastoreUser"), ("/sdn/zones/umiak", "PVESDNUser"), ("/storage/" + media_name, "UmiakTemplateMedia"), ("/pool/umiak", "UmiakConsole")]:
        if not any(x.get("path") == path and x.get("ugid") == principal and x.get("roleid") == role for x in acls):
            mutate(["pveum", "acl", "modify", path, principal_flag, principal, "--roles", role], ["pveum", "acl", "delete", path, principal_flag, principal, "--roles", role])

create("/cluster/sdn/zones", "/cluster/sdn/zones/umiak", "--zone", "umiak", "--type", "simple", "--ipam", "pve", "--dhcp", "dnsmasq")
create("/cluster/sdn/vnets", "/cluster/sdn/vnets/umiak0", "--vnet", "umiak0", "--zone", "umiak", "--isolate-ports", "1")
create("/cluster/sdn/vnets/umiak0/subnets", "/cluster/sdn/vnets/umiak0/subnets/umiak-10.88.0.0-24", "--subnet", "10.88.0.0/24", "--type", "subnet", "--gateway", "10.88.0.1", "--snat", "1", "--dhcp-range", "start-address=10.88.0.100,end-address=10.88.0.250", "--dhcp-dns-server", guest_dns)
if not exists("/cluster/firewall/ipset/umiak-gateway"):
    create("/cluster/firewall/ipset", "/cluster/firewall/ipset/umiak-gateway", "--name", "umiak-gateway")
if not any(x.get("cidr") == config["gateway"] for x in get("/cluster/firewall/ipset/umiak-gateway")):
    mutate(["pvesh", "create", "/cluster/firewall/ipset/umiak-gateway", "--cidr", config["gateway"], "--comment", "Umiak guest gateway"], ["pvesh", "delete", "/cluster/firewall/ipset/umiak-gateway/" + config["gateway"]])
if not exists("/cluster/firewall/groups/umiak-egress"):
    create("/cluster/firewall/groups", "/cluster/firewall/groups/umiak-egress", "--group", "umiak-egress", "--comment", "Umiak sandbox egress")
existing_rules = sorted(get("/cluster/firewall/groups/umiak-egress"), key=lambda row: int(row.get("pos", 0)))
for position, rule in enumerate(desired_rules):
    if position < len(existing_rules) and all(str(existing_rules[position].get(key, "")) == str(value) for key, value in rule.items()):
        continue
    args = [part for key, value in rule.items() for part in ["--" + key, str(value)]]
    mutate(["pvesh", "create", "/cluster/firewall/groups/umiak-egress", *args, "--pos", str(position)], ["pvesh", "delete", "/cluster/firewall/groups/umiak-egress/" + str(position)])
    existing_rules.insert(position, rule)
apply_sdn()

node_binary = Path("/usr/local/bin/umiak-node")
backup(node_binary)
node_binary.write_bytes(binary)
node_binary.chmod(0o755)
node_config = f'''node = "{config['node']}"
vg = "{storage['vgname']}"
thinPool = "{storage['thinpool']}"
storage = "{storage_name}"
isoDir = {json.dumps(media_path.rstrip("/") + "/template/iso")}
importDir = {json.dumps(media_path.rstrip("/") + "/import")}
vmidMin = 500
vmidMax = 589
templateVmidMin = 595
templateVmidMax = 599
templateVmid = 599
sdnZone = "umiak"
vnet = "umiak0"
clusterId = 1
'''
backup(Path("/etc/umiak-node.toml"))
Path("/etc/umiak-node.toml").write_text(node_config)
line = 'restrict,command="/usr/local/bin/umiak-node --stdio" ' + config["publicKey"]
authorized = Path("/etc/pve/priv/authorized_keys")
content = authorized.read_text() if authorized.exists() else ""
if line not in content.splitlines():
    backup(authorized)
    authorized.write_text(content.rstrip() + "\n" + line + "\n")
probe = subprocess.run([str(node_binary), "--stdio"], input=json.dumps({"op": "version", "args": {}}), text=True, capture_output=True, check=True)
if not json.loads(probe.stdout).get("ok"):
    raise SystemExit("Node-agent verification failed; rollback timer remains armed")
host_key = Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text().split()
report = {"token": config["token"], "mediaStorage": media_name, "tokenSecret": token_path.read_text().strip(), "caPem": Path("/etc/pve/pve-root-ca.pem").read_text(), "sshPublicKey": " ".join(host_key[:2])}
request = urllib.request.Request(config["origin"] + "/quickstart/setup/callback", data=json.dumps(report).encode(), headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    if response.status != 200:
        raise SystemExit("Callback failed; rollback timer remains armed")
active_file.unlink(missing_ok=True)
print("Host prepared and credentials reported. Re-run Adopt in the owner dashboard.")
