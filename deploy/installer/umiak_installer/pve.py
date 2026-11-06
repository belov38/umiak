"""Thin, injectable access to the Proxmox host: argv-only commands and paths.

Commands are always argv lists (never shell strings). Host filesystem paths go
through Runner.path() so tests can sandbox them under a temporary root.
"""

import json
import os
import socket
import subprocess
import time
from pathlib import Path


class InstallerError(Exception):
    """A precondition or verification failed; the message is safe to print."""


class CommandError(Exception):
    def __init__(self, argv, returncode, stdout="", stderr=""):
        # Only the program name is in the message: arguments may carry data the
        # caller does not want in logs, and stderr is kept for inspection.
        super().__init__(f"{argv[0]} failed with exit code {returncode}")
        self.argv = list(argv)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


PCT_EXEC_ATTEMPTS = 3
SIGHUP_EXIT = 129
RETRY_DELAY_S = 1.0


class Runner:
    def __init__(self, root: Path = Path("/"), sleep=time.sleep):
        self.root = Path(root)
        self.sleep = sleep

    def run(self, argv: list[str], input: str | None = None) -> str:
        argv = list(argv)
        if not argv or not all(isinstance(part, str) for part in argv):
            raise TypeError("argv must be a non-empty list of strings")
        # Retry `pct exec` only when lxc-attach itself was hung up (128 + SIGHUP);
        # installer commands in the CT are idempotent, so a repeat is safe.
        attempts = PCT_EXEC_ATTEMPTS if argv[:2] == ["pct", "exec"] else 1
        for attempt in range(attempts):
            try:
                # Never inherit the installer's terminal: with a tty on stdin,
                # lxc-attach allocates a pty and can be hung up (exit 129) even
                # though the command inside the CT succeeded.
                result = subprocess.run(argv, input=input, stdin=None if input is not None else subprocess.DEVNULL,
                                        text=True, capture_output=True, check=False)
            except FileNotFoundError as error:
                raise CommandError(argv, 127, "", str(error)) from error
            if result.returncode != SIGHUP_EXIT or attempt == attempts - 1:
                break
            self.sleep(RETRY_DELAY_S)
        if result.returncode != 0:
            raise CommandError(argv, result.returncode, result.stdout, result.stderr)
        return result.stdout.strip()

    def path(self, name: str | Path) -> Path:
        """Map an absolute host path into this runner's root."""
        text = str(name)
        if not text.startswith("/"):
            raise ValueError("host paths must be absolute: " + text)
        if self.root == Path("/"):
            return Path(text)
        return self.root / text.lstrip("/")

    def euid(self) -> int:
        return os.geteuid()

    def hostname(self) -> str:
        return socket.gethostname().split(".")[0]


def get(runner: Runner, path: str, *options: str):
    return json.loads(runner.run(["pvesh", "get", path, *options, "--output-format", "json"]) or "null")


def exists(runner: Runner, path: str) -> bool:
    try:
        get(runner, path)
        return True
    except CommandError:
        return False


def pending_sdn(runner: Runner) -> bool:
    """True when any SDN zone, VNet or subnet has staged (unapplied) changes.

    Default PVE SDN reads omit pending metadata, so ask for it explicitly.
    """
    vnets = get(runner, "/cluster/sdn/vnets", "--pending", "1")
    paths = ["/cluster/sdn/zones", "/cluster/sdn/vnets", *[f"/cluster/sdn/vnets/{row['vnet']}/subnets" for row in vnets]]
    for path in paths:
        for row in get(runner, path, "--pending", "1"):
            if row.get("pending") or row.get("state") in ["new", "changed", "deleted"]:
                return True
    return False


def private_dir(path: Path) -> None:
    """Create a directory with an explicit 0700 mode (independent of the umask)."""
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def write_secret(path: Path, data: str | bytes) -> None:
    """Write a file readable only by its owner, never exposing it at a wider mode."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(data.encode() if isinstance(data, str) else data)


def _on_node(row: dict, node: str) -> bool:
    return not row.get("disable") and (not row.get("nodes") or node in str(row["nodes"]).split(","))


def media_storages(runner: Runner, node: str) -> list[dict]:
    """Enabled directory storages with iso and import content, `local` first.

    The media ACL, node-agent paths and template builds all use the same one;
    do not assume the administrator kept the name `local`.
    """
    rows = [
        row for row in get(runner, "/storage")
        if row.get("type") == "dir"
        and {"import", "iso"}.issubset(set(str(row.get("content", "")).split(",")))
        and _on_node(row, node)
    ]
    return sorted(rows, key=lambda row: (row["storage"] != "local", row["storage"]))


def bridges(runner: Runner) -> list[str]:
    """Linux bridges on this host (vmbr0, vmbr1, …)."""
    net = runner.path("/sys/class/net")
    return sorted(p.name for p in net.iterdir() if (p / "bridge").is_dir()) if net.is_dir() else []


def lan_bridge(runner: Runner) -> str | None:
    """The bridge that carries this host's default route: the LAN the node itself is on."""
    try:
        routes = json.loads(runner.run(["ip", "-j", "route", "show", "default"]))
    except (CommandError, ValueError):
        return None
    found = bridges(runner)
    return next((row["dev"] for row in routes if row.get("dev") in found), None)


def lvmthin_storages(runner: Runner, node: str) -> list[dict]:
    return [row for row in get(runner, "/storage") if row.get("type") == "lvmthin" and _on_node(row, node)]
