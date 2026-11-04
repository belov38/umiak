"""Installer state on the cluster filesystem, so any node sees the install."""

import dataclasses
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PATH = Path("/etc/pve/umiak/install-state.json")
# In install order: the tailnet identity (origin, preview domain, SSH host) is
# needed before the stack's .env and install.json can be written.
PHASES = ("prepared", "ct-created", "tailnet-up", "stack-up", "complete")


@dataclass(frozen=True)
class InstallState:
    version: int
    ct_id: int
    ct_ip: str
    node: str
    release: str
    tailnet_host: str | None
    phase: str
    # Install answers (storage, ranges, addresses, hostname) so Resume needs no questions.
    answers: dict = field(default_factory=dict)
    # Bookkeeping only; runtime.nodes is authoritative.
    sandbox_nodes: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.phase not in PHASES:
            raise ValueError("Unknown install phase: " + str(self.phase))


def load(path: Path = DEFAULT_PATH) -> InstallState | None:
    try:
        raw = Path(path).read_text()
    except FileNotFoundError:
        return None
    data = json.loads(raw)
    fields = {field.name for field in dataclasses.fields(InstallState)}
    return InstallState(**{key: value for key, value in data.items() if key in fields})


def save(state: InstallState, path: Path = DEFAULT_PATH) -> None:
    """Write atomically: a temp file in the same directory, then rename over."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(dataclasses.asdict(state), indent=2, sort_keys=True) + "\n"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
