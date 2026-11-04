# Fake Proxmox node with an LXC control plane on top of fake_pve.FakeRunner:
# pct/pveam, the CT's docker/tailscale/gpg, and the node's ip/ping. Every argv
# is recorded; behaviour is scripted through attributes.
import base64
import json
from pathlib import Path

from fake_pve import FakeRunner
from umiak_installer import ct
from umiak_installer.pve import CommandError

AGENT = b"fake-node-agent-binary"
CODE = "AbCdEf123456"
SERVICES = ["web-meta", "gateway-secrets", "secrets-init", "postgres", "migrate", "web-migrate", "worker", "api",
            "web", "mcp", "gateway", "gateway-renewal", "quickstart"]
ONESHOT = {"gateway-secrets", "secrets-init", "migrate", "web-migrate"}
CERT_DER = b"fake-der-certificate"
TS_STATUS = {
    "BackendState": "Running",
    "TailscaleIPs": ["100.64.10.20", "fd7a:115c:a1e0::1"],
    "CertDomains": ["umiak.tail0000.ts.net"],
    "Self": {"DNSName": "umiak.tail0000.ts.net."},
}


def ps_rows(services=SERVICES, oneshot_exit=0, health="healthy"):
    rows = []
    for name in services:
        if name in ONESHOT:
            rows.append({"Service": name, "State": "exited", "Health": "", "ExitCode": oneshot_exit})
        else:
            rows.append({"Service": name, "State": "running", "Health": health if name in ("api", "worker") else "",
                         "ExitCode": 0})
    return rows


class CtFake(FakeRunner):
    def __init__(self, root: Path, **kwargs):
        super().__init__(root, **kwargs)
        self.local_templates = []  # names on storage `local`
        self.available = ["debian-12-standard_12.12-1_amd64.tar.zst", "debian-13-standard_13.4-1_amd64.tar.zst",
                          "debian-13-standard_13.6-1_amd64.tar.zst", "ubuntu-24.04-standard_24.04-2_amd64.tar.zst"]
        self.quickstart_running = False
        self.ip_in_use = False  # answers ping and ARP
        self.ip_arp_only = False  # answers ARP only, like a device that ignores ICMP
        self.dns_broken = False
        self.ts_states = []  # successive tailscale status payloads, last one repeats
        self.ps_payloads = []  # successive `docker compose ps` row lists, last one repeats
        self.logs = (f"Umiak one-time setup code: {CODE}\n"
                     "Umiak owner HTTP ingress ready on :4180\n")
        self.pushed = {}  # CT path -> bytes at push time
        self.objects["/cluster/resources"].append({"vmid": 110, "type": "lxc", "name": "ilia-ct", "tags": "home"})
        pem = "-----BEGIN CERTIFICATE-----\n" + base64.b64encode(CERT_DER).decode() + "\n-----END CERTIFICATE-----\n"
        path = self.path("/etc/pve/local/pve-ssl.pem")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(pem)

    def run(self, argv, input=None):
        argv = list(argv)
        if argv[0] not in ("pct", "pveam", "ping", "arping") and argv[:2] != ["ip", "-j"]:
            return super().run(argv, input)
        assert all(isinstance(part, str) for part in argv), argv
        self.commands.append(argv)
        self.inputs.append(input)
        if self.fail_on and self.fail_on(argv):
            raise CommandError(argv, 1, "", "injected failure")
        if argv[:2] == ["pveam", "list"]:
            return "NAME SIZE\n" + "".join(f"local:vztmpl/{name} 120MB\n" for name in self.local_templates)
        if argv[:2] == ["pveam", "available"]:
            return "".join(f"system          {name}\n" for name in self.available)
        if argv[:2] == ["pveam", "download"]:
            self.local_templates.append(argv[3])
            return ""
        if argv[0] == "arping":
            if self.ip_in_use or self.ip_arp_only:
                raise CommandError(argv, 1, "", "reply")
            return ""
        if argv[0] == "ping":
            if self.ip_in_use:
                return "64 bytes from"
            raise CommandError(argv, 1, "", "unreachable")
        if argv[:5] == ["ip", "-j", "-4", "addr", "show"]:
            return json.dumps([{"ifname": "vmbr0", "addr_info": [{"local": "192.168.68.10", "prefixlen": 22}]}])
        if argv[:4] == ["ip", "-j", "route", "show"]:
            return json.dumps([{"dst": "default", "gateway": "192.168.68.1", "dev": "vmbr0"}])
        if argv[:2] == ["pct", "create"]:
            tags = argv[argv.index("--tags") + 1]
            self.objects["/cluster/resources"].append(
                {"vmid": int(argv[2]), "type": "lxc", "name": argv[argv.index("--hostname") + 1], "tags": tags})
            return ""
        if argv[:2] == ["pct", "push"]:
            self.pushed[argv[4]] = Path(argv[3]).read_bytes()
            return ""
        if argv[:2] == ["pct", "pull"]:
            Path(argv[4]).write_bytes(AGENT)
            return ""
        if argv[:2] == ["pct", "exec"]:
            return self._in_ct(argv[argv.index("--") + 1:], input)
        return ""

    def _in_ct(self, argv, input):
        if argv[:1] == ["timeout"]:
            argv = argv[2:]
        if argv[:2] == ["getent", "hosts"] and self.dns_broken:
            raise CommandError(argv, 2, "", "")
        if argv[:2] == ["cat", "/etc/resolv.conf"]:
            return "search taileb6984.ts.net\nnameserver 100.100.100.100"
        if argv[:2] == ["gpg", "--show-keys"]:
            fpr = ct.DOCKER_KEY_FPR if "docker" in argv[-1] else ct.TAILSCALE_KEY_FPR
            return f"pub:-:4096:1:X:1::::::scESC::::::23::0:\nfpr:::::::::{fpr}:\nsub:-:4096\nfpr:::::::::00AA:\n"
        if argv[:3] == ["tailscale", "status", "--json"]:
            state = self.ts_states.pop(0) if len(self.ts_states) > 1 else (self.ts_states or [TS_STATUS])[0]
            return json.dumps(state)
        if argv[:2] == ["docker", "compose"]:
            rest = argv[argv.index("--project-directory") + 2:]
            if rest[:2] == ["config", "--services"]:
                return "\n".join(SERVICES)
            if rest[:1] == ["ps"] and "-q" in rest:
                return "c0ffee" if "--status" not in rest or self.quickstart_running else ""
            if rest[:1] == ["up"]:
                self.quickstart_running = True
                return ""
            if rest[:1] == ["ps"]:
                rows = self.ps_payloads.pop(0) if len(self.ps_payloads) > 1 else (self.ps_payloads or [ps_rows()])[0]
                return "\n".join(json.dumps(row) for row in rows)
            if rest[:1] == ["logs"]:
                return self.logs
            return ""
        if argv[:2] == ["docker", "inspect"]:
            return "2026-11-04T10:00:00.000000000Z"
        if argv[:2] == ["docker", "create"]:
            return "0123456789ab"
        return ""

    def ct_commands(self):
        return [argv[argv.index("--") + 1:] for argv in self.commands if argv[:2] == ["pct", "exec"]]
