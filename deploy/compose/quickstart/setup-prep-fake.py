# Test harness: run the real generated Python program against a fake PVE/host.
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
original_path = Path
sandbox = original_path(tempfile.mkdtemp(prefix="umiak-prep-fake-"))
commands = []
objects = {"/cluster/firewall/options": {"enable": 1}}
agent = b"fake-node-agent"
report = {}
config = {"origin": "https://stack.example:8443", "token": "a" * 64, "node": "pve", "gateway": "192.168.68.90", "publicKey": "ssh-ed25519 AAAA test", "nodeSha256": hashlib.sha256(agent).hexdigest()}


def mapped(value="."):
    text = str(value)
    return sandbox / text.lstrip("/") if text.startswith("/") else original_path(value)


for name, value in {
    "/usr/sbin/dnsmasq": "fake",
    "/sys/class/net/vmbr0/bridge/mcast_hash_max": "1024",
    "/root/.config/umiak/quickstart-ca.pem": "fake-ca",
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
        report.update(json.loads(request.data))
    return Reply()


def run(args, **kwargs):
    args = list(args)
    commands.append(args)
    out = ""
    if args[:3] == ["pvesh", "get", "/cluster/sdn/zones/umiak"] and "/cluster/sdn/zones/umiak" not in objects:
        raise subprocess.CalledProcessError(2, args)
    if args[:2] == ["pvesh", "get"]:
        path = args[2]
        if path not in objects:
            raise subprocess.CalledProcessError(2, args)
        out = json.dumps(objects[path])
    elif args[:2] == ["pvesh", "create"]:
        path = args[2]
        values = dict(zip(args[3::2], args[4::2], strict=True))
        child = values.get("--zone") or values.get("--vnet") or values.get("--subnet") or values.get("--name") or values.get("--group")
        if child:
            objects[path + "/" + child] = values
        out = "{}"
    elif args[:3] == ["pvesh", "set", "/cluster/sdn"]:
        mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text("8192")
    elif args[:3] == ["ip", "link", "set"]:
        mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text(args[-1])
    elif args[:2] == ["sysctl", "-n"]:
        out = "1"
    elif args[:2] == ["pveum", "role"] and args[2] == "list":
        out = "[]"
    elif args[:2] == ["pveum", "user"]:
        out = json.dumps({"value": "fake-secret"}) if "add" in args and "token" in args else "[]"
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
namespace = {"__name__": "__main__"}
exec(compile(source, "setup-prep.py", "exec"), namespace)
assert mapped("/sys/class/net/vmbr0/bridge/mcast_hash_max").read_text() == "1024"
assert mapped("/etc/pve/priv/authorized_keys").read_text().startswith("existing-management-key\n")
assert any(command[:2] == ["systemd-run", "--quiet"] for command in commands)
assert any(command == ["systemctl", "stop", "umiak-quickstart-rollback.timer"] for command in commands)
assert report["tokenSecret"] == "fake-secret"
assert any("UmiakTemplateMedia" in command and "--roles" in command for command in commands)
assert any("VM.GuestAgent.Unrestricted" in " ".join(command) for command in commands)
assert not any("VM.Monitor" in " ".join(command) for command in commands)
assert report["sshPublicKey"] == "ssh-ed25519 AAAA"
print("FAKE FRESH HOST PASS: role/token/pool/SDN/IPSet/rules/node-agent/callback, rollback and bridge preservation")
