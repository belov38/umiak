"""The control-plane LXC: create (or resume) it and install Docker and Tailscale.

The CT is unprivileged Debian 13 with nesting and keyctl for Docker and
/dev/net/tun for Tailscale, on vmbr0 with a static address. Packages come only
from Docker's and Tailscale's signed apt repositories; each repository key's
fingerprint is checked before apt trusts it. Nothing is piped into a shell.

An existing guest with the requested ID is reused only when it is a CT tagged
`umiak`; anything else is refused untouched.
"""

import ipaddress
import time
from dataclasses import dataclass

from .prepare_host import NAME
from .pve import CommandError, InstallerError, Runner, get

TEMPLATE_STORAGE = "local"
TEMPLATE = "debian-13-standard_13.6-1_amd64.tar.zst"
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
    network = ipaddress.IPv4Network(f"{spec.gw}/{spec.cidr}", strict=False)
    if ip not in network or ip == gw or ip in (network.network_address, network.broadcast_address):
        raise InstallerError(f"CT address {ip} must be a host address in {network} other than the router")


def existing(runner: Runner, ct_id: int) -> dict | None:
    return next((row for row in get(runner, "/cluster/resources", "--type", "vm") if int(row["vmid"]) == ct_id), None)


def is_umiak_ct(row: dict) -> bool:
    tags = str(row.get("tags", "")).replace(",", ";").split(";")
    return row.get("type") == "lxc" and TAG in tags


def _address_in_use(runner: Runner, ip: str) -> bool:
    try:
        runner.run(["ping", "-c", "1", "-W", "1", ip])
        return True
    except CommandError:
        return False


def _ensure_template(runner: Runner) -> None:
    listing = runner.run(["pveam", "list", TEMPLATE_STORAGE])
    if f"{TEMPLATE_STORAGE}:vztmpl/{TEMPLATE}" not in listing.split():
        runner.run(["pveam", "download", TEMPLATE_STORAGE, TEMPLATE])


def create_argv(spec: CtSpec) -> list[str]:
    return [
        "pct", "create", str(spec.id), f"{TEMPLATE_STORAGE}:vztmpl/{TEMPLATE}",
        "--unprivileged", "1", "--features", "nesting=1,keyctl=1", "--dev0", "/dev/net/tun",
        "--memory", str(spec.memory), "--cores", str(spec.cores), "--rootfs", f"{spec.storage}:{spec.disk_gb}",
        "--net0", f"name=eth0,bridge=vmbr0,ip={spec.ip}/{spec.cidr},gw={spec.gw}",
        "--onboot", "1", "--tags", TAG, "--hostname", spec.hostname,
    ]


def _wait_network(runner: Runner, ct_id: int, sleep, attempts: int = 60) -> None:
    for _ in range(attempts):
        try:
            run_in(runner, ct_id, "getent", "hosts", "deb.debian.org")
            return
        except CommandError:
            sleep(2)
    raise InstallerError("The control-plane container has no working network or DNS")


def _trust_key(runner: Runner, ct_id: int, url: str, path: str, fingerprint: str) -> None:
    run_in(runner, ct_id, "install", "-d", "-m", "0755", path.rsplit("/", 1)[0])
    run_in(runner, ct_id, "curl", "-fsSL", "--proto", "=https", "-o", path, url)
    listing = run_in(runner, ct_id, "gpg", "--show-keys", "--with-colons", path)
    # The first fpr record after the primary key ("pub") is its fingerprint.
    lines = listing.splitlines()
    primary = next((lines[n + 1] for n, line in enumerate(lines[:-1]) if line.startswith("pub:")), "")
    if primary.split(":")[9:10] != [fingerprint]:
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


def create(runner: Runner, spec: CtSpec, sleep=time.sleep) -> None:
    """Create and start the CT (or resume an existing Umiak CT), then install packages. Idempotent."""
    validate(spec)
    row = existing(runner, spec.id)
    if row is not None and not is_umiak_ct(row):
        raise InstallerError(f"Guest {spec.id} exists and is not an Umiak container; choose another CT ID")
    if row is None:
        if _address_in_use(runner, spec.ip):
            raise InstallerError(f"Address {spec.ip} is already in use on the LAN; choose a free static address")
        _ensure_template(runner)
        runner.run(create_argv(spec))
    status = runner.run(["pct", "status", str(spec.id)])
    if "running" not in status:
        runner.run(["pct", "start", str(spec.id)])
    _wait_network(runner, spec.id, sleep)
    install_packages(runner, spec.id)
