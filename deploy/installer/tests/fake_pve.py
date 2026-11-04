# Fake Proxmox VE host for installer tests: an in-memory pvesh/pveum model plus
# a sandboxed filesystem root. Every argv the library runs is recorded.
import json
from pathlib import Path

from umiak_installer.pve import CommandError, Runner

HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfPve root@pve"

# Commands that change host or cluster state (used to assert "no writes").
MUTATING = {
    ("pvesh", "create"),
    ("pvesh", "set"),
    ("pvesh", "delete"),
    ("systemd-run",),
    ("ssh-keygen",),
    ("ip", "link"),
    ("apt-get",),
}


def is_mutation(argv):
    if argv[0] == "pveum":
        return argv[1:3] not in (["role", "list"], ["user", "list"]) and argv[1:4] != ["user", "token", "list"]
    return any(tuple(argv[: len(prefix)]) == prefix for prefix in MUTATING)


class FakeRunner(Runner):
    def __init__(
        self,
        root: Path,
        *,
        dnsmasq=True,
        dnsmasq_enabled=False,
        strict_deletes=True,
        ip_forward="1",
        firewall=1,
        euid=0,
        hostname="pve",
        version="9.0.11",
        quorate=1,
        guests=None,
    ):
        super().__init__(root)
        self.commands = []
        self.inputs = []
        self._euid = euid
        self._hostname = hostname
        self.fail_on = None  # predicate(argv) -> bool: inject a command failure
        self.token_counter = 0
        self.roles, self.users, self.tokens, self.acls = [], [], [], []
        self.objects = {
            "/version": {"version": version, "release": version.rsplit(".", 1)[0]},
            "/cluster/status": [
                {"type": "cluster", "name": "ms02", "quorate": quorate, "nodes": 2},
                {"type": "node", "name": "pve", "ip": "192.168.68.10", "local": 1, "online": 1},
                {"type": "node", "name": "pve2", "ip": "192.168.68.11", "local": 0, "online": 1},
            ],
            "/cluster/resources": list(guests or [{"vmid": 103, "type": "qemu", "name": "ilia-vm"}]),
            "/cluster/firewall/options": {"enable": firewall},
            "/nodes/pve/firewall/options": {"enable": 1},
            "/nodes/pve/qemu": [],
            "/cluster/sdn/zones": [],
            "/cluster/sdn/vnets": [],
            "/access/acl": self.acls,
            "/storage": [
                {"storage": "local", "type": "dir", "content": "iso,vztmpl,backup,import", "path": "/var/lib/vz"},
                {"storage": "local-lvm", "type": "lvmthin", "content": "rootdir,images", "vgname": "pve", "thinpool": "data"},
            ],
            "/storage/local-lvm": {"type": "lvmthin", "vgname": "pve", "thinpool": "data"},
            "/storage/local": {"type": "dir", "path": "/var/lib/vz"},
        }
        files = {
            "/sys/class/net/vmbr0/bridge/mcast_hash_max": "1024",
            "/etc/pve/pve-root-ca.pem": "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
            "/etc/pve/priv/authorized_keys": "ssh-rsa AAAA existing-management-key\n",
            "/etc/ssh/ssh_host_ed25519_key.pub": HOST_KEY + "\n",
        }
        if ip_forward == "1":
            files["/etc/sysctl.d/99-umiak.conf"] = "net.ipv4.ip_forward = 1\n"
        if dnsmasq:
            files["/usr/sbin/dnsmasq"] = "fake"
        self.ip_forward = ip_forward
        self.dnsmasq_enabled = dnsmasq_enabled
        # Like real pvesh/pveum: deleting a missing object exits non-zero.
        self.strict_deletes = strict_deletes
        for name, value in files.items():
            path = self.path(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        for name in ["/var/lib", "/usr/local/bin", "/etc"]:
            self.path(name).mkdir(parents=True, exist_ok=True)

    def euid(self):
        return self._euid

    def hostname(self):
        return self._hostname

    def _listing(self, path):
        # Index listings computed from the model, like the real API.
        def children(prefix, field):
            return [{field: key[len(prefix):]} for key in self.objects
                    if key.startswith(prefix) and "/" not in key[len(prefix):]]

        if path == "/access/roles":
            return [{"roleid": x["roleid"]} for x in self.roles]
        if path == "/access/users":
            return [{"userid": x["userid"]} for x in self.users]
        if path == "/pools":
            return children("/pools/", "poolid")
        if path == "/cluster/firewall/ipset":
            return children("/cluster/firewall/ipset/", "name")
        if path == "/cluster/firewall/groups":
            return children("/cluster/firewall/groups/", "group")
        if path.startswith("/access/users/") and path.endswith("/token"):
            user = path.split("/")[3]
            if not any(x["userid"] == user for x in self.users):
                raise CommandError(["pvesh", "get", path], 2, "", "no such user")
            return [{"tokenid": x["tokenid"]} for x in self.tokens]
        return None

    def _missing(self, argv):
        if argv[:3] == ["pveum", "role", "delete"]:
            return not any(x["roleid"] == argv[3] for x in self.roles)
        if argv[:3] == ["pveum", "pool", "delete"]:
            return "/pools/" + argv[3] not in self.objects
        if argv[:3] == ["pveum", "user", "delete"]:
            return not any(x["userid"] == argv[3] for x in self.users)
        if argv[:4] == ["pveum", "user", "token", "remove"]:
            return not any(x["tokenid"] == argv[5] for x in self.tokens)
        if argv[:3] == ["pveum", "acl", "delete"]:
            return {"path": argv[3], "ugid": argv[5], "roleid": argv[7]} not in self.acls
        return False

    def mutations(self):
        return [argv for argv in self.commands if is_mutation(argv)]

    def run(self, argv, input=None):
        argv = list(argv)
        assert all(isinstance(part, str) for part in argv), argv
        self.commands.append(argv)
        self.inputs.append(input)
        if self.fail_on and self.fail_on(argv):
            raise CommandError(argv, 1, "", "injected failure")
        out = ""
        head = argv[:2]
        if head == ["pvesh", "get"] and self._listing(argv[2]) is not None:
            out = json.dumps(self._listing(argv[2]))
        elif head == ["pvesh", "get"]:
            path = argv[2]
            if path not in self.objects:
                raise CommandError(argv, 2, "", "no such object")
            value = self.objects[path]
            if "--pending" not in argv:
                if isinstance(value, list):
                    value = [{k: v for k, v in row.items() if k not in ["pending", "state"]} for row in value]
                elif isinstance(value, dict):
                    value = {k: v for k, v in value.items() if k not in ["pending", "state"]}
            else:
                assert argv[argv.index("--pending") + 1] == "1"
            out = json.dumps(value)
        elif head == ["pvesh", "create"]:
            path = argv[2]
            values = dict(zip(argv[3::2], argv[4::2], strict=True))
            child = (
                values.get("--zone") if path.endswith("zones")
                else values.get("--vnet") if path.endswith("vnets")
                else values.get("--subnet") or values.get("--name") or values.get("--group")
            )
            if child:
                child_path = path + "/" + child
                if "subnets" in path:
                    child_path = path + "/umiak-10.88.0.0-24"
                if child_path in self.objects:
                    raise CommandError(argv, 2, "", "exists")
                self.objects[child_path] = [] if "/firewall/" in path else {
                    k.removeprefix("--"): v for k, v in values.items()
                }
                if path.endswith("subnets"):
                    self.objects.setdefault(path, []).append({"subnet": "umiak-10.88.0.0-24"})
                elif path.endswith(("zones", "vnets")):
                    self.objects[path].append({path.rsplit("/", 1)[1][:-1]: child})
                    if path.endswith("vnets"):
                        self.objects[child_path + "/subnets"] = []
            elif path in self.objects and isinstance(self.objects[path], list):
                row = {k.removeprefix("--"): v for k, v in values.items()}
                if "cidr" in row:
                    if any(old.get("cidr") == row["cidr"] for old in self.objects[path]):
                        raise CommandError(argv, 2, "", "exists")
                    self.objects[path].append(row)
                else:
                    # Real PVE ignores --pos on create and always prepends.
                    self.objects[path].insert(0, row)
                    for pos, item in enumerate(self.objects[path]):
                        item["pos"] = pos
            out = "{}"
        elif head == ["pvesh", "delete"]:
            path = argv[2]
            if path in self.objects:
                if isinstance(self.objects[path], list) and self.objects[path]:
                    raise CommandError(argv, 2, "", "not empty")
                del self.objects[path]
                self.objects.pop(path + "/subnets", None)
                parent, key = path.rsplit("/", 1)
                if isinstance(self.objects.get(parent), list):
                    self.objects[parent] = [
                        row for row in self.objects[parent]
                        if key not in (row.get("zone"), row.get("vnet"), row.get("subnet"))
                    ]
            else:
                parent, key = path.rsplit("/", 1)
                rows = self.objects.get(parent, [])
                if self.strict_deletes and not any(str(row.get("cidr", row.get("pos"))) == key for row in rows):
                    raise CommandError(argv, 2, "", "no such entry")
                kept = [row for row in rows if str(row.get("cidr", row.get("pos"))) != key]
                for pos, item in enumerate(kept):
                    if "pos" in item:
                        item["pos"] = pos
                self.objects[parent] = kept
        elif argv[:3] == ["pvesh", "set", "/cluster/sdn"]:
            self.path("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text("8192")
        elif head == ["pvesh", "set"] and "--moveto" in argv and isinstance(
            self.objects.get(argv[2].rsplit("/", 1)[0]), list
        ):
            rows = self.objects[argv[2].rsplit("/", 1)[0]]
            at, target = int(argv[2].rsplit("/", 1)[1]), int(argv[argv.index("--moveto") + 1])
            row = rows.pop(at)
            rows.insert(min(target - 1 if target > at else target, len(rows)), row)
            for pos, item in enumerate(rows):
                item["pos"] = pos
        elif head == ["pvesh", "set"]:
            values = dict(zip(argv[3::2], argv[4::2], strict=True))
            target = self.objects[argv[2]]
            for flag, value in values.items():
                key = flag.removeprefix("--")
                if key == "delete":
                    target.pop(value, None)
                else:
                    target[key] = value if key == "nodes" else int(value)
        elif argv == ["iptables", "-t", "nat", "-S", "POSTROUTING"]:
            out = "-A POSTROUTING -s 10.88.0.0/24 -o vmbr0 -j SNAT --to-source 192.168.68.11"
        elif argv == ["ip", "-j", "address", "show", "dev", "umiak0"]:
            out = json.dumps([{"addr_info": [{"local": "10.88.0.1", "prefixlen": 24}]}])
        elif argv[:3] == ["ip", "link", "set"]:
            self.path("/sys/class/net/vmbr0/bridge/mcast_hash_max").write_text(argv[-1])
        elif argv[:3] == ["systemctl", "is-enabled", "dnsmasq"]:
            if not self.dnsmasq_enabled:
                raise CommandError(argv, 1, "disabled", "")
            out = "enabled"
        elif head == ["sysctl", "-n"]:
            out = self.ip_forward
        elif head == ["ifquery", "--check"]:
            out = "auto vmbr0\niface vmbr0 inet static  [pass]\n"
        elif self.strict_deletes and self._missing(argv):
            raise CommandError(argv, 255, "", "does not exist")
        elif head == ["pveum", "role"]:
            if argv[2] == "list":
                out = json.dumps(self.roles)
            elif argv[2] == "add":
                self.roles.append({"roleid": argv[3], "privs": argv[5]})
                self.objects["/access/roles/" + argv[3]] = {"privs": argv[5]}
            elif argv[2] == "delete":
                self.roles[:] = [x for x in self.roles if x["roleid"] != argv[3]]
                self.objects.pop("/access/roles/" + argv[3], None)
        elif argv[:3] == ["pveum", "pool", "add"]:
            self.objects["/pools/" + argv[3]] = {"poolid": argv[3], "members": []}
        elif argv[:3] == ["pveum", "pool", "delete"]:
            self.objects.pop("/pools/" + argv[3], None)
        elif head == ["pveum", "user"]:
            if argv[2] == "list":
                out = json.dumps(self.users)
            elif argv[2] == "add":
                self.users.append({"userid": argv[3]})
                self.objects["/access/users/" + argv[3]] = {"enable": 1}
            elif argv[2] == "delete":
                self.users[:] = [x for x in self.users if x["userid"] != argv[3]]
                self.objects.pop("/access/users/" + argv[3], None)
            elif argv[2:4] == ["token", "list"]:
                out = json.dumps(self.tokens)
            elif argv[2:4] == ["token", "add"]:
                self.token_counter += 1
                self.tokens.append({"tokenid": argv[5]})
                self.objects[f"/access/users/{argv[4]}/token/{argv[5]}"] = {"privsep": 1}
                out = json.dumps({"full-tokenid": f"{argv[4]}!{argv[5]}", "value": f"fake-secret-{self.token_counter}"})
            elif argv[2:4] == ["token", "remove"]:
                self.tokens[:] = [x for x in self.tokens if x["tokenid"] != argv[5]]
                # Like PVE (remove_token -> delete_user_acl): the token's ACLs go too.
                self.acls[:] = [x for x in self.acls if x["ugid"] != f"{argv[4]}!{argv[5]}"]
                self.objects.pop(f"/access/users/{argv[4]}/token/{argv[5]}", None)
        elif head == ["pveum", "acl"]:
            acl = {"path": argv[3], "ugid": argv[5], "roleid": argv[7]}
            if argv[2] == "modify":
                self.acls.append(acl)
            elif argv[2] == "delete":
                self.acls[:] = [x for x in self.acls if x != acl]
        elif argv[0] == "ssh-keygen":
            key = Path(argv[argv.index("-f") + 1])
            assert not key.exists(), "ssh-keygen must not overwrite a key"
            key.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n")
            key.with_name(key.name + ".pub").write_text("ssh-ed25519 AAAAgeneratedNodeKey umiak-node\n")
        elif argv[-1] == "--stdio":
            assert json.loads(input) == {"op": "version", "args": {}}
            out = json.dumps({"ok": True, "result": {"version": "fake"}})
        return out
