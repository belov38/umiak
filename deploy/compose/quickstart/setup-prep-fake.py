# Test harness: run the real generated Python program against a fake PVE/host.
import atexit
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import pathlib
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.request

source = Path(sys.argv[1]).read_text()
scenario = sys.argv[2] if len(sys.argv) > 2 else "success"
fail_callback = scenario in ["partial-failure-rerun", "nonempty-delete"]
roles, users, tokens, acls = [], [], [], []
original_path = Path
sandbox = original_path(tempfile.mkdtemp(prefix="umiak-prep-fake-"))
commands = []
objects = {"/cluster/firewall/options": {"enable": 0 if scenario == "disabled-firewall" else 1}, "/nodes/pve/firewall/options": {"enable": 1}, "/cluster/sdn/zones": [], "/cluster/sdn/vnets": [], "/access/acl": acls, "/storage": [{"storage":"media","type":"dir","content":"iso,import","path":"/srv/media"}], "/storage/fast": {"type":"lvmthin","vgname":"custom-vg","thinpool":"custom-pool"}}
if scenario == "pending-sdn": objects["/cluster/sdn/zones"] = [{"zone":"foreign","pending":1}]
if scenario == "pending-subnet":
    objects["/cluster/sdn/vnets"] = [{"vnet":"foreign"}]
    objects["/cluster/sdn/vnets/foreign/subnets"] = [{"subnet":"foreign-10.9.0.0-24","state":"changed"}]
if scenario.startswith("pending-state-"):
    _, _, kind, state = scenario.split("-", 3)
    if kind == "zone": objects["/cluster/sdn/zones"] = [{"zone":"foreign", "state":state}]
    elif kind == "vnet": objects["/cluster/sdn/vnets"] = [{"vnet":"foreign", "state":state}]
    else:
        objects["/cluster/sdn/vnets"] = [{"vnet":"foreign"}]
        objects["/cluster/sdn/vnets/foreign/subnets"] = [{"subnet":"foreign-10.9.0.0-24", "state":state}]
agent = b"fake-node-agent"
report = {}
config = {"origin": "http://stack.example:4180", "token": "a" * 64, "node": "pve", "gateway": "192.168.68.90", "publicKey": "ssh-ed25519 AAAA test", "tokenId": "developer@pve!quickstart", "nodeSha256": hashlib.sha256(agent).hexdigest(), "storage": "fast", "templateVmidMin": 700, "templateVmidMax": 704}


def mapped(value="."):
    text = str(value)
    return original_path(text) if text.startswith(str(sandbox)) else sandbox / text.lstrip("/") if text.startswith("/") else original_path(value)


for name, value in {
    "/usr/sbin/dnsmasq": "fake",
    "/sys/class/net/vmbr0/bridge/mcast_hash_max": "1024",
    "/etc/ssl/certs/ca-certificates.crt": "fake-ca",
    "/etc/pve/pve-root-ca.pem": "fake-pve-ca",
    "/etc/pve/priv/authorized_keys": "existing-management-key\n",
    "/etc/ssh/ssh_host_ed25519_key.pub": "ssh-ed25519 AAAA host\n",
}.items():
    file = mapped(name)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(value)


for name in ["/var/lib", "/usr/local/bin"]:
    mapped(name).mkdir(parents=True, exist_ok=True)


class Reply:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self):
        return agent


def urlopen(request, **_kwargs):
    if isinstance(request, urllib.request.Request):
        if fail_callback:
            raise RuntimeError("injected callback failure")
        report.update(json.loads(request.data))
    else:
        assert request == config["origin"] + "/pve-setup.sh?token=" + config["token"] + "&asset=node-agent"
    return Reply()


def run(args, **kwargs):
    args = list(args)
    commands.append(args)
    out = ""
    if scenario == "collected-timer" and args[:2] == ["systemctl", "stop"]:
        assert not kwargs.get("check")
        assert kwargs.get("stderr") == subprocess.DEVNULL
        return subprocess.CompletedProcess(args, 5, stdout="", stderr="timer already collected")
    if args[:3] == ["pvesh", "get", "/cluster/sdn/zones/umiak"] and "/cluster/sdn/zones/umiak" not in objects:
        raise subprocess.CalledProcessError(2, args)
    if args[:2] == ["pvesh", "get"]:
        path = args[2]
        if path not in objects:
            raise subprocess.CalledProcessError(2, args)
        value = objects[path]
        if "--pending" not in args:
            if isinstance(value, list): value = [{key: item for key,item in row.items() if key not in ["pending", "state"]} for row in value]
            elif isinstance(value, dict): value = {key:item for key,item in value.items() if key not in ["pending", "state"]}
        else:
            assert args[args.index("--pending") + 1] == "1"
        out = json.dumps(value)
    elif args[:2] == ["pvesh", "create"]:
        path = args[2]
        values = dict(zip(args[3::2], args[4::2], strict=True))
        child = values.get("--zone") if path.endswith("zones") else values.get("--vnet") if path.endswith("vnets") else values.get("--subnet") or values.get("--name") or values.get("--group")
        if child:
            child_path = path + "/" + child
            if "subnets" in path: child_path = path + "/umiak-10.88.0.0-24"
            if child_path in objects: raise subprocess.CalledProcessError(2,args)
            objects[child_path] = [] if "/firewall/" in path else {key.removeprefix("--"): value for key,value in values.items()}
        elif path in objects and isinstance(objects[path],list):
            row = {key.removeprefix("--"): value for key,value in values.items()}
            if "cidr" in row:
                if any(old.get("cidr") == row["cidr"] for old in objects[path]): raise subprocess.CalledProcessError(2,args)
                objects[path].append(row)
            else:
                objects[path].insert(int(values.get("--pos",0)),row)
                for pos,row in enumerate(objects[path]): row["pos"] = pos
        out = "{}"
    elif args[:2] == ["pvesh", "delete"]:
        path = args[2]
        if path in objects:
            if isinstance(objects[path],list) and objects[path]: raise subprocess.CalledProcessError(2,args)
            del objects[path]
        else:
            parent, key = path.rsplit("/",1)
            rows = objects.get(parent,[])
            objects[parent] = [row for row in rows if str(row.get("cidr",row.get("pos"))) != key]
    elif args[:3] == ["pvesh", "set", "/cluster/sdn"]:
        mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text("8192")
    elif args[:3] == ["ip", "link", "set"]:
        mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text(args[-1])
    elif args[:2] == ["sysctl", "-n"]:
        out = "1"
    elif args[:2] == ["pveum", "role"]:
        if args[2] == "list": out = json.dumps(roles)
        elif args[2] == "add": roles.append({"roleid":args[3]})
        elif args[2] == "delete": roles[:] = [x for x in roles if x["roleid"] != args[3]]
    elif args[:3] == ["pveum", "pool", "add"]:
        objects["/pools/"+args[3]] = {}
    elif args[:3] == ["pveum", "pool", "delete"]:
        objects.pop("/pools/"+args[3],None)
    elif args[:2] == ["pveum", "user"]:
        if args[2] == "list": out = json.dumps(users)
        elif args[2] == "add": users.append({"userid":args[3]})
        elif args[2] == "delete": users[:] = [x for x in users if x["userid"] != args[3]]
        elif args[2:4] == ["token","list"]: out = json.dumps(tokens)
        elif args[2:4] == ["token","add"]:
            tokens.append({"tokenid":args[5]}); out = json.dumps({"value":"fake-secret"})
        elif args[2:4] == ["token","remove"]: tokens[:] = [x for x in tokens if x["tokenid"] != args[5]]
    elif args[:2] == ["pveum", "acl"]:
        acl = {"path":args[3], "ugid":args[5], "roleid":args[7]}
        if args[2] == "modify": acls.append(acl)
        elif args[2] == "delete": acls[:] = [x for x in acls if x != acl]
    elif args[-1] == "--stdio":
        out = json.dumps({"ok": True, "result": {"version": "fake"}})
    return subprocess.CompletedProcess(args, 0, stdout=out, stderr="")


pathlib.Path = mapped
subprocess.run = run
os.geteuid = lambda: 0
socket.gethostname = lambda: "pve"
ssl.create_default_context = lambda **_: object()
urllib.request.urlopen = urlopen
sys.argv = ["setup-prep.py", base64.b64encode(json.dumps(config).encode()).decode()]
def execute():
    namespace = {"__name__": "__main__"}
    try:
        exec(compile(source, "setup-prep.py", "exec"), namespace)
    except BaseException:
        if "rollback_on_exit" in namespace:
            atexit.unregister(namespace["rollback_on_exit"])
            namespace["rollback_on_exit"]()
        raise
    finally:
        pass
    return namespace

if scenario == "disabled-firewall" or scenario.startswith("pending-"):
    try: execute()
    except SystemExit as error: assert "firewall" in str(error) or "Pending SDN" in str(error)
    else: raise AssertionError("Disabled firewall accepted")
    assert not any(args[0] in ["pveum","systemd-run"] or args[:2] == ["pvesh","create"] for args in commands)
    assert not mapped("/var/lib/umiak-quickstart").exists()
    print("SCENARIO PASS: " + scenario)
    sys.exit(0)
if fail_callback:
    before_objects = json.loads(json.dumps(objects))
    try: execute()
    except RuntimeError as error: assert "injected" in str(error)
    else: raise AssertionError("Failure not injected")
    assert not roles and not users and not tokens and not acls
    assert objects == before_objects, (objects, before_objects)
    assert not mapped("/usr/local/bin/umiak-node").exists()
    assert not mapped("/etc/umiak-node.toml").exists()
    assert mapped("/etc/pve/priv/authorized_keys").read_text() == "existing-management-key\n"
    fail_callback = False
namespace = execute()
# Run the real registered atexit callback before retrying in this test process.
atexit._run_exitfuncs()
# A successful rerun tolerates every pre-existing object, CIDR, ACL and token.
namespace = execute()
atexit._run_exitfuncs()
assert 'vg = "custom-vg"' in mapped("/etc/umiak-node.toml").read_text()
assert 'templateVmidMin = 700' in mapped('/etc/umiak-node.toml').read_text()
assert 'templateVmidMax = 704' in mapped('/etc/umiak-node.toml').read_text()
assert 'templateVmid = 0' in mapped('/etc/umiak-node.toml').read_text()
assert 'storage = "fast"' in mapped("/etc/umiak-node.toml").read_text()
if scenario != "success": print("SCENARIO PASS: " + scenario)
assert mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").read_text() == "1024"
assert mapped("/etc/pve/priv/authorized_keys").read_text().startswith("existing-management-key\n")
assert any(command[:2] == ["systemd-run", "--quiet"] for command in commands)
assert sum(command == ["systemctl", "stop", "umiak-quickstart-rollback.timer"] for command in commands) == (3 if scenario in ["partial-failure-rerun", "nonempty-delete"] else 2)
assert report["tokenSecret"] == "fake-secret"
assert any("UmiakTemplateMedia" in command and "/storage/media" in command for command in commands)
assert not any("/storage/local" in command for command in commands)
assert report["mediaStorage"] == "media"
assert 'isoDir = "/srv/media/template/iso"' in mapped("/etc/umiak-node.toml").read_text()
assert any("VM.GuestAgent.Unrestricted" in " ".join(command) for command in commands)
assert not any("VM.Monitor" in " ".join(command) for command in commands)
assert report["sshPublicKey"] == "ssh-ed25519 AAAA"
assert any(command[:6] == ["pveum", "user", "token", "add", "developer@pve", "quickstart"] for command in commands)
# Both the user and its separated token need root-only read access to proxy options.
assert ["pveum", "role", "add", "UmiakDatacenterAudit", "--privs", "Sys.Audit"] in commands
for flag, principal in [("--users", "developer@pve"), ("--tokens", "developer@pve!quickstart")]:
    assert ["pveum", "acl", "modify", "/", flag, principal, "--roles", "UmiakDatacenterAudit", "--propagate", "0"] in commands
print("FAKE FRESH HOST PASS: role/token/pool/SDN/IPSet/rules/node-agent/callback, rollback and bridge preservation")
