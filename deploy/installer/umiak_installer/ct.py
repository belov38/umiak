"""The control-plane LXC: create (or resume) it and install Docker and Tailscale.

The CT is unprivileged Debian 13 with nesting and keyctl for Docker and
/dev/net/tun for Tailscale, on vmbr0 with a static address. Packages come only
from Docker's and Tailscale's signed apt repositories; each repository key's
fingerprint is checked before apt trusts it. Nothing is piped into a shell.

An existing guest with the requested ID is reused only when it is a CT tagged
`umiak`; anything else is refused untouched.
"""

import ipaddress
import re
import time
from dataclasses import dataclass

from .prepare_host import NAME
from .pve import CommandError, InstallerError, Runner, get

TEMPLATE_STORAGE = "local"
# Any Debian 13 point release Proxmox publishes; the newest one wins.
TEMPLATE_RE = re.compile(r"debian-13-standard_(\d+(?:\.\d+)*-\d+)_amd64\.tar\.zst")
TAG = "umiak"
DOCKER_KEY_URL = "https://download.docker.com/linux/debian/gpg"
DOCKER_KEY = "/etc/apt/keyrings/docker.asc"
DOCKER_KEY_FPR = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
TAILSCALE_KEY_URL = "https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg"
TAILSCALE_KEY = "/usr/share/keyrings/tailscale-archive-keyring.gpg"
TAILSCALE_KEY_FPR = "2596A99EAAB33821893C0A79458CA832957F5868"
DOCKER_SOURCES = (
    "Types: deb\n"
    "URIs: https://download.docker.com/linux/debian\n"
    "Suites: trixie\n"
    "Components: stable\n"
    "Architectures: amd64\n"
    f"Signed-By: {DOCKER_KEY}\n"
)
TAILSCALE_SOURCES = f"deb [signed-by={TAILSCALE_KEY}] https://pkgs.tailscale.com/stable/debian trixie main\n"
PACKAGES = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin",
            "tailscale", "iptables"]
APT = ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get"]


@dataclass(frozen=True)
class CtSpec:
    id: int
    ip: str
    cidr: int
    gw: str
    storage: str
    hostname: str = "umiak-cp"
    memory: int = 4096
    cores: int = 2
    disk_gb: int = 32
    # Explicit resolver: without --nameserver pct copies the HOST's resolv.conf (e.g. Tailscale MagicDNS
    # 100.100.100.100), which does not answer inside the CT before tailscaled runs. With a nameserver
    # given and no --searchdomain, pct writes no search line (it inherits both only when neither is set).
    dns: str = "1.1.1.1"
    bridge: str = "vmbr0"


def exec_argv(ct_id: int, *argv: str) -> list[str]:
    return ["pct", "exec", str(ct_id), "--", *argv]


def run_in(runner: Runner, ct_id: int, *argv: str, input: str | None = None) -> str:
    return runner.run(exec_argv(ct_id, *argv), input=input)


def write_file(runner: Runner, ct_id: int, path: str, content: str) -> None:
    """Write a non-secret file in the CT via stdin (the path is a positional argument, never shell text)."""
    run_in(runner, ct_id, "sh", "-c", 'cat > "$1"', "sh", path, input=content)


def validate(spec: CtSpec) -> None:
    if not (isinstance(spec.id, int) and 100 <= spec.id <= 999_999_999):
        raise InstallerError("Invalid CT ID")
    if not NAME.fullmatch(spec.storage) or not NAME.fullmatch(spec.hostname):
        raise InstallerError("Invalid storage or hostname")
    if not (isinstance(spec.cidr, int) and 8 <= spec.cidr <= 30):
        raise InstallerError("Invalid LAN prefix length")
    try:
        ip = ipaddress.IPv4Address(spec.ip)
        gw = ipaddress.IPv4Address(spec.gw)
    except ValueError as error:
        raise InstallerError(f"Invalid address: {error}") from error
    try:
        resolvers = [ipaddress.ip_address(item) for item in spec.dns.replace(",", " ").split()]
    except ValueError as error:
        raise InstallerError(f"Invalid DNS server: {error}") from error
    if not resolvers:
        raise InstallerError("Invalid DNS server: none given")
    network = ipaddress.IPv4Network(f"{spec.gw}/{spec.cidr}", strict=False)
    if ip not in network or ip == gw or ip in (network.network_address, network.broadcast_address):
        raise InstallerError(f"CT address {ip} must be a host address in {network} other than the router")


def existing(runner: Runner, ct_id: int) -> dict | None:
    return next((row for row in get(runner, "/cluster/resources", "--type", "vm") if int(row["vmid"]) == ct_id), None)


def is_umiak_ct(row: dict) -> bool:
    tags = str(row.get("tags", "")).replace(",", ";").split(";")
    return row.get("type") == "lxc" and TAG in tags


ARPING_PATHS = ("/usr/bin/arping", "/usr/sbin/arping")


def have_arping(runner: Runner) -> bool:
    return any(runner.path(name).exists() for name in ARPING_PATHS)


def address_in_use(runner: Runner, ip: str, bridge: str = "vmbr0") -> bool:
    """ARP duplicate-address detection first (devices that ignore ICMP still answer ARP), then ping."""
    if have_arping(runner):
        try:
            runner.run(["arping", "-D", "-c", "2", "-w", "3", "-I", bridge, ip])
        except CommandError as error:
            if error.returncode != 1:  # iputils: 1 = a reply arrived (duplicate); anything else is a failed probe
                raise InstallerError(f"Could not probe {ip} with arping on {bridge}: {error.stderr.strip() or error}") from error
            return True
    try:
        runner.run(["ping", "-c", "1", "-W", "1", ip])
        return True
    except CommandError:
        return False


def check_target(runner: Runner, spec: CtSpec) -> dict | None:
    """Read-only: the CT ID must be free or an Umiak CT; a new CT needs a free address.

    Returns the existing Umiak CT row, or None when the CT will be created.
    """
    row = existing(runner, spec.id)
    if row is not None and not is_umiak_ct(row):
        raise InstallerError(f"Guest {spec.id} exists and is not an Umiak container; choose another CT ID")
    if row is None and address_in_use(runner, spec.ip, spec.bridge):
        raise InstallerError(f"Address {spec.ip} is already in use on the LAN; choose a free static address")
    return row


def _newest(names) -> str | None:
    found = [(tuple(int(n) for n in re.findall(r"\d+", m.group(1))), m.group(0))
             for m in (TEMPLATE_RE.fullmatch(name) for name in names) if m]
    return max(found)[1] if found else None


def ensure_template(runner: Runner) -> str:
    """Newest Debian 13 template already on `local`, else the newest available one (downloaded)."""
    try:
        runner.run(["pveam", "update"])
    except CommandError:
        pass  # A stale index still lists templates; a local one may already exist.
    prefix = f"{TEMPLATE_STORAGE}:vztmpl/"
    local = [word[len(prefix):] for word in runner.run(["pveam", "list", TEMPLATE_STORAGE]).split()
             if word.startswith(prefix)]
    name = _newest(local)
    if name is None:
        available = [line.split()[1] for line in runner.run(["pveam", "available", "--section", "system"]).splitlines()
                     if len(line.split()) == 2]
        name = _newest(available)
        if name is None:
            raise InstallerError("No Debian 13 container template is available from Proxmox (pveam available)")
        runner.run(["pveam", "download", TEMPLATE_STORAGE, name])
    return name


def create_argv(spec: CtSpec, template: str) -> list[str]:
    return [
        "pct", "create", str(spec.id), f"{TEMPLATE_STORAGE}:vztmpl/{template}",
        "--unprivileged", "1", "--features", "nesting=1,keyctl=1", "--dev0", "/dev/net/tun",
        "--memory", str(spec.memory), "--cores", str(spec.cores), "--rootfs", f"{spec.storage}:{spec.disk_gb}",
        "--net0", f"name=eth0,bridge={spec.bridge},ip={spec.ip}/{spec.cidr},gw={spec.gw}",
        "--nameserver", " ".join(spec.dns.replace(",", " ").split()),
        "--onboot", "1", "--tags", TAG, "--hostname", spec.hostname,
    ]


def _wait_network(runner: Runner, ct_id: int, sleep, say=lambda _: None, attempts: int = 60) -> None:
    """Wait up to attempts*2 s (default 120 s) for DNS in the CT; each probe is itself time-limited."""
    for n in range(1, attempts + 1):
        try:
            run_in(runner, ct_id, "timeout", "5", "getent", "hosts", "deb.debian.org")
            return
        except CommandError:
            if n % 5 == 1:
                say(f"Waiting for DNS in container {ct_id} (attempt {n}/{attempts})")
            sleep(2)
    try:
        resolv = run_in(runner, ct_id, "cat", "/etc/resolv.conf").strip()
    except CommandError:
        resolv = "(unreadable)"
    raise InstallerError(
        f"The control-plane container {ct_id} has no working network or DNS after {attempts * 2} s. "
        f"Its /etc/resolv.conf says: {resolv!r}. Check the CT address (pct config {ct_id}) "
        "for an IP conflict and that the DNS server is reachable")


def _trust_key(runner: Runner, ct_id: int, url: str, path: str, fingerprint: str) -> None:
    run_in(runner, ct_id, "install", "-d", "-m", "0755", path.rsplit("/", 1)[0])
    run_in(runner, ct_id, "curl", "-fsSL", "--proto", "=https", "-o", path, url)
    listing = run_in(runner, ct_id, "gpg", "--show-keys", "--with-colons", path)
    # Exactly one primary key ("pub"); the fpr record right after it is its fingerprint.
    lines = listing.splitlines()
    primaries = [lines[n + 1] if n + 1 < len(lines) else "" for n, line in enumerate(lines) if line.startswith("pub:")]
    if len(primaries) != 1 or primaries[0].split(":")[9:10] != [fingerprint]:
        run_in(runner, ct_id, "rm", "-f", path)
        raise InstallerError(f"Unexpected apt repository signing key from {url}; refusing to trust it")
    run_in(runner, ct_id, "chmod", "0644", path)


def install_packages(runner: Runner, ct_id: int) -> None:
    run_in(runner, ct_id, *APT, "update")
    run_in(runner, ct_id, *APT, "install", "-y", "--no-install-recommends", "ca-certificates", "curl", "gnupg")
    _trust_key(runner, ct_id, DOCKER_KEY_URL, DOCKER_KEY, DOCKER_KEY_FPR)
    _trust_key(runner, ct_id, TAILSCALE_KEY_URL, TAILSCALE_KEY, TAILSCALE_KEY_FPR)
    write_file(runner, ct_id, "/etc/apt/sources.list.d/docker.sources", DOCKER_SOURCES)
    write_file(runner, ct_id, "/etc/apt/sources.list.d/tailscale.list", TAILSCALE_SOURCES)
    run_in(runner, ct_id, *APT, "update")
    run_in(runner, ct_id, *APT, "install", "-y", *PACKAGES)
    run_in(runner, ct_id, "systemctl", "enable", "--now", "docker.service", "tailscaled.service")


def create(runner: Runner, spec: CtSpec, sleep=time.sleep, say=lambda _: None) -> None:
    """Create and start the CT (or resume an existing Umiak CT), then install packages. Idempotent."""
    validate(spec)
    if check_target(runner, spec) is None:
        runner.run(create_argv(spec, ensure_template(runner)))
    status = runner.run(["pct", "status", str(spec.id)])
    if "running" not in status:
        runner.run(["pct", "start", str(spec.id)])
    _wait_network(runner, spec.id, sleep, say)
    install_packages(runner, spec.id)
