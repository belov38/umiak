"""The compose stack inside the control-plane CT.

Layout in the CT: /opt/umiak/compose.yaml (+ the files it mounts) and
/opt/umiak/.env with exactly four public values. Compose project `umiak`, so
named volumes are `umiak_<name>`. Secrets travel only as files: `pct push
--perms 0600` into a root-only staging directory, then a throwaway container
copies them into the `umiak_pve-secrets` volume; staging is always removed.
"""

import hashlib
import ipaddress
import json
import re
import ssl
import time
from pathlib import Path

from .ct import run_in, write_file
from .prepare_host import TOKEN_ID
from .pve import InstallerError, Runner, write_secret
from .release import Release

DIR = "/opt/umiak"
PROJECT = "umiak"
STAGING = "/root/.umiak-staging"
ENV_KEYS = ("UMIAK_VERSION", "UMIAK_PUBLIC_URL", "UMIAK_PREVIEW_DOMAIN", "UMIAK_SSH_HOST")
# compose.yaml and every repo-relative file it bind-mounts or builds from.
STACK_FILES = (
    "compose.yaml",
    "deploy/compose/meta-proxy.mjs",
    "deploy/compose/canonical-fetch.mjs",
    "deploy/compose/quickstart/run.mjs",
    "deploy/compose/quickstart/bootstrap.sh",
    "deploy/compose/config/identity.yaml",
    "deploy/compose/secrets-init/init.sh",
)
SECRET_NAMES = ("install.json", "pve-token", "pve-token-id", "pve-root-ca.pem", "umiak-node_ed25519", "known_hosts",
                "host-report.json")
QUICKSTART_IMAGE = "ghcr.io/belov38/umiak-quickstart:{version}"
ONESHOT = frozenset({"gateway-secrets", "secrets-init", "migrate", "web-migrate"})
NODE_AGENT_IN_IMAGE = "/app/quickstart-assets/umiak-node-linux-amd64"
EXTRACT_NAME = "umiak-node-extract"
EXTRACT_PATH = "/root/umiak-node-linux-amd64"
FIREWALL_SCRIPT = "/usr/local/sbin/umiak-ports"
FIREWALL_UNIT = "/etc/systemd/system/umiak-ports.service"
# Owner HTTP, port previews and sandbox SSH; 443 (guest tunnel) stays open on the LAN.
TAILNET_ONLY_PORTS = (4180, 8085, 2222)
CLAIM_CODE = re.compile(r"Umiak one-time setup code: (\S+)")
# Printed by deploy/compose/quickstart/server.mjs: the import runs before listening.
QUICKSTART_READY = "Umiak owner HTTP ingress ready on"
IMPORT_FAILED = re.compile(r"installer import failed: (.*)")
# Quickstart services run as uid/gid 1000 (image user `node`).
APP_UID = "1000"


def compose(*args: str) -> list[str]:
    return ["docker", "compose", "--project-directory", DIR, *args]


def quickstart_image(version: str) -> str:
    return QUICKSTART_IMAGE.format(version=version)


def _dashed(ip: str) -> str:
    return str(ipaddress.IPv4Address(ip)).replace(".", "-")


def preview_domain(tailnet_ip: str) -> str:
    return f"umiak.{_dashed(tailnet_ip)}.sslip.io"


def tunnel_url(gateway: str) -> str:
    """Same derivation as validateNetwork in deploy/compose/quickstart/setup.mjs."""
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", gateway):
        return f"wss://tunnel.{gateway.replace('.', '-')}.sslip.io/v1/connect"
    return f"wss://{gateway}/v1/connect"


def network_json(gateway: str, preview: str, guest_dns: str) -> bytes:
    """Exactly the bytes of JSON.stringify(validateNetwork(...)) in the quickstart network step."""
    network = {"gatewayAddress": gateway, "previewDomain": preview, "tunnelUrl": tunnel_url(gateway),
               "guestDns": guest_dns}
    return json.dumps(network, separators=(",", ":"), ensure_ascii=False).encode()


def install_json(*, release: str, node: str, node_ip: str, fingerprint: str, ct_ip: str, guest_dns: str,
                 tailnet_dns: str, tailnet_ip: str, limits: dict) -> dict:
    """Installer facts for deploy/compose/quickstart/bootstrap.mjs (version 1)."""
    host = f"[{node_ip}]" if ":" in node_ip else node_ip
    return {
        "version": 1,
        "release": release,
        "connection": {"apiUrl": f"https://{host}:8006", "node": node, "tokenId": TOKEN_ID,
                       "fingerprint": fingerprint, "tlsName": node, "sshHost": node_ip},
        "limits": dict(limits),
        "network": {"gatewayAddress": ct_ip, "guestDns": guest_dns, "previewDomain": preview_domain(tailnet_ip),
                    "sshHost": tailnet_ip},
        "publicUrl": f"https://{tailnet_dns}",
    }


def env_text(env: dict) -> str:
    if set(env) != set(ENV_KEYS):
        raise InstallerError("The stack .env takes exactly: " + ", ".join(ENV_KEYS))
    for key in ENV_KEYS:
        if not re.fullmatch(r"[A-Za-z0-9.:/_+-]+", str(env[key])):
            raise InstallerError(f"Invalid value for {key}")
    return "".join(f"{key}={env[key]}\n" for key in ENV_KEYS)


def _push(runner: Runner, ct_id: int, local: Path, remote: str, perms: str) -> None:
    runner.run(["pct", "push", str(ct_id), str(local), remote, "--perms", perms])


def write(runner: Runner, ct_id: int, release: Release, env: dict, work_dir: Path) -> None:
    """Write compose.yaml, its mounted files and the public .env into /opt/umiak."""
    text = env_text(env)
    for name in STACK_FILES:
        source = release.root / name
        if not source.is_file():
            raise InstallerError("Release bundle is missing " + name)
        parent = f"{DIR}/{name}".rsplit("/", 1)[0]
        run_in(runner, ct_id, "install", "-d", "-m", "0755", parent)
        _push(runner, ct_id, source, f"{DIR}/{name}", "0644")
    work_dir = Path(work_dir)
    work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    env_file = work_dir / "stack.env"
    env_file.write_text(text)
    _push(runner, ct_id, env_file, f"{DIR}/.env", "0644")


def _copy_into_volume(runner: Runner, ct_id: int, image: str, volume: str, mount: str, mode: str) -> None:
    script = f'set -eu; for f in /in/*; do install -o {APP_UID} -g {APP_UID} -m {mode} "$f" "{mount}/${{f##*/}}"; done'
    run_in(runner, ct_id, "docker", "run", "--rm", "--network", "none", "--user", "0:0",
           "-v", f"{PROJECT}_{volume}:{mount}", "-v", f"{STAGING}:/in:ro", "--entrypoint", "sh", image, "-c", script)


def _staged(runner: Runner, ct_id: int, files: dict[str, Path], image: str, volume: str, mount: str,
            mode: str) -> None:
    run_in(runner, ct_id, "rm", "-rf", STAGING)
    try:
        run_in(runner, ct_id, "install", "-d", "-m", "0700", STAGING)
        for name, path in files.items():
            _push(runner, ct_id, path, f"{STAGING}/{name}", "0600")
        _copy_into_volume(runner, ct_id, image, volume, mount, mode)
    finally:
        run_in(runner, ct_id, "rm", "-rf", STAGING)


def push_secrets(runner: Runner, ct_id: int, files: dict[str, Path], image: str) -> None:
    for name, path in files.items():
        if name not in SECRET_NAMES:
            raise InstallerError("Unexpected secret file name: " + name)
        if Path(path).stat().st_mode & 0o077:
            raise InstallerError(f"Secret file {name} must be readable by its owner only")
    _staged(runner, ct_id, files, image, "pve-secrets", "/s", "0600")


def write_network(runner: Runner, ct_id: int, content: bytes, image: str, work_dir: Path) -> None:
    work_dir = Path(work_dir)
    work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    local = work_dir / "quickstart-network.json"
    local.write_bytes(content)
    local.chmod(0o600)
    _staged(runner, ct_id, {"quickstart-network.json": local}, image, "network-config", "/n", "0644")


def firewall_script(node_lan_ip: str) -> str:
    try:
        node = str(ipaddress.IPv4Address(node_lan_ip))
    except ValueError as error:
        raise InstallerError("Invalid node LAN address") from error
    rules = "".join(
        f"iptables -A UMIAK-PORTS -i eth0 -p tcp -m conntrack --ctproto tcp --ctdir ORIGINAL "
        f"--ctorigdstport {port} ! -s {node} -j DROP\n"
        for port in TAILNET_ONLY_PORTS
    )
    return (
        "#!/bin/sh\n"
        "# Managed by the Umiak installer. Owner HTTP, previews and sandbox SSH are\n"
        "# reachable only via tailscale0, loopback and the Proxmox node (ssh -L).\n"
        "set -eu\n"
        "iptables -N UMIAK-PORTS 2>/dev/null || true\n"
        "iptables -F UMIAK-PORTS\n"
        f"{rules}"
        "iptables -N DOCKER-USER 2>/dev/null || true\n"
        "iptables -C DOCKER-USER -j UMIAK-PORTS 2>/dev/null || iptables -I DOCKER-USER 1 -j UMIAK-PORTS\n"
    )


# Before docker.service: the rules exist before Docker starts any container at
# boot (Docker keeps an existing DOCKER-USER chain and only adds its jump to it).
# PartOf re-runs the script whenever Docker restarts.
FIREWALL_UNIT_TEXT = f"""[Unit]
Description=Umiak: restrict owner, preview and SSH ports to the tailnet
Before=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={FIREWALL_SCRIPT}

[Install]
WantedBy=multi-user.target docker.service
"""


def write_firewall(runner: Runner, ct_id: int, node_lan_ip: str) -> None:
    script = firewall_script(node_lan_ip)
    write_file(runner, ct_id, FIREWALL_SCRIPT, script)
    run_in(runner, ct_id, "chmod", "0755", FIREWALL_SCRIPT)
    write_file(runner, ct_id, FIREWALL_UNIT, FIREWALL_UNIT_TEXT)
    run_in(runner, ct_id, "systemctl", "daemon-reload")
    run_in(runner, ct_id, "systemctl", "enable", "umiak-ports.service")
    run_in(runner, ct_id, "systemctl", "restart", "umiak-ports.service")


def pull(runner: Runner, ct_id: int) -> None:
    run_in(runner, ct_id, *compose("pull", "--quiet"))


def create(runner: Runner, ct_id: int) -> None:
    """Create containers, networks and the compose-labelled volumes without starting anything."""
    run_in(runner, ct_id, *compose("create"))


def _rows(output: str) -> list[dict]:
    output = output.strip()
    if not output:
        return []
    if output.startswith("["):
        return json.loads(output)
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def wait_healthy(runner: Runner, ct_id: int, sleep=time.sleep, clock=time.monotonic, timeout: float = 300) -> None:
    services = set(run_in(runner, ct_id, *compose("config", "--services")).split())
    long_running = services - ONESHOT
    deadline = clock() + timeout
    while True:
        rows = _rows(run_in(runner, ct_id, *compose("ps", "-a", "--format", "json")))
        for row in rows:
            if row.get("Service") in ONESHOT and row.get("State") == "exited" and int(row.get("ExitCode", 0)) != 0:
                raise InstallerError(f"Service {row['Service']} exited with code {row['ExitCode']}; "
                                     f"see: pct exec {ct_id} -- docker compose --project-directory {DIR} logs")
        ready = {row.get("Service") for row in rows
                 if row.get("State") == "running" and row.get("Health", "") in ("", "healthy")}
        if long_running <= ready:
            return
        if clock() >= deadline:
            missing = ", ".join(sorted(long_running - ready))
            raise InstallerError(f"Services not healthy after {int(timeout)}s: {missing}")
        sleep(5)


def start(runner: Runner, ct_id: int, sleep=time.sleep, clock=time.monotonic, timeout: float = 300) -> None:
    """`docker compose up -d`, then wait (≤ timeout) until services are healthy."""
    run_in(runner, ct_id, *compose("up", "-d"))
    wait_healthy(runner, ct_id, sleep=sleep, clock=clock, timeout=timeout)


def up(runner: Runner, ct_id: int, sleep=time.sleep, clock=time.monotonic, timeout: float = 300) -> None:
    """`docker compose pull && docker compose up -d` with the health wait."""
    pull(runner, ct_id)
    start(runner, ct_id, sleep=sleep, clock=clock, timeout=timeout)


def restart(runner: Runner, ct_id: int, *services: str) -> None:
    run_in(runner, ct_id, *compose("restart", *services))


def quickstart_running(runner: Runner, ct_id: int) -> bool:
    return bool(run_in(runner, ct_id, *compose("ps", "-q", "--status", "running", "quickstart")).strip())


def wait_bootstrap(runner: Runner, ct_id: int, sleep=time.sleep, attempts: int = 90) -> None:
    """Wait until quickstart listens; fail if its installer import failed since its last start.

    safeBootstrap only logs the failure (the server still starts), so the health
    wait alone cannot see it.
    """
    container = run_in(runner, ct_id, *compose("ps", "-q", "quickstart")).strip()
    if not container:
        raise InstallerError("The quickstart service has no container")
    started = run_in(runner, ct_id, "docker", "inspect", "--format", "{{.State.StartedAt}}", container).strip()
    for _ in range(attempts):
        logs = run_in(runner, ct_id, *compose("logs", "--no-color", "--no-log-prefix", "--since", started, "quickstart"))
        failures = IMPORT_FAILED.findall(logs)
        if failures:
            raise InstallerError("The control plane could not import the installer facts: " + failures[-1].strip())
        if QUICKSTART_READY in logs:
            return
        sleep(2)
    raise InstallerError(f"The quickstart service did not start listening; see: pct exec {ct_id} -- "
                         f"docker compose --project-directory {DIR} logs quickstart")


def extract_node_agent(runner: Runner, ct_id: int, image: str, dest: Path) -> Path:
    """Copy the node-agent out of the pulled quickstart image onto the node (mode 0600, unverified)."""
    run_in(runner, ct_id, "docker", "rm", "-f", EXTRACT_NAME)
    try:
        run_in(runner, ct_id, "docker", "create", "--name", EXTRACT_NAME, image)
        run_in(runner, ct_id, "docker", "cp", f"{EXTRACT_NAME}:{NODE_AGENT_IN_IMAGE}", EXTRACT_PATH)
    finally:
        run_in(runner, ct_id, "docker", "rm", "-f", EXTRACT_NAME)
    dest = Path(dest)
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    dest.unlink(missing_ok=True)
    try:
        runner.run(["pct", "pull", str(ct_id), EXTRACT_PATH, str(dest)])
    finally:
        run_in(runner, ct_id, "rm", "-f", EXTRACT_PATH)
    dest.chmod(0o600)
    return dest


def claim_code(logs: str) -> str | None:
    """The latest one-time setup code (each quickstart start replaces the previous one)."""
    codes = CLAIM_CODE.findall(logs)
    return codes[-1] if codes else None


def wait_claim_code(runner: Runner, ct_id: int, sleep=time.sleep, attempts: int = 60) -> str:
    for _ in range(attempts):
        code = claim_code(run_in(runner, ct_id, *compose("logs", "--no-color", "--no-log-prefix", "quickstart")))
        if code:
            return code
        sleep(2)
    raise InstallerError("No setup code in the quickstart logs. If this deployment is already claimed, "
                         "use 'Sign in a new browser' from the installer menu.")


def pve_fingerprint(runner: Runner) -> str:
    """SHA256 of the DER certificate the PVE API presents (custom pveproxy cert first)."""
    for name in ("/etc/pve/local/pveproxy-ssl.pem", "/etc/pve/local/pve-ssl.pem"):
        path = runner.path(name)
        if path.exists():
            block = re.search(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", path.read_text(), re.S)
            if not block:
                break
            return hashlib.sha256(ssl.PEM_cert_to_DER_cert(block.group(0))).hexdigest()
    raise InstallerError("Cannot read this node's Proxmox API certificate")


def write_install_json(data: dict, out_dir: Path) -> Path:
    path = Path(out_dir) / "install.json"
    write_secret(path, json.dumps(data, indent=2) + "\n")
    return path

