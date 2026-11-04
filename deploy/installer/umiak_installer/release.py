"""Release bundles: resolve a version, download over HTTPS, verify, unpack.

A bundle `umiak-installer-<version>.tar.gz` is published on the GitHub release
`v<version>` next to `SHA256SUMS`. Its root holds:

- `VERSION` — the version string;
- `umiak_installer/` — this package;
- `compose.yaml` with images pinned to the version, plus every file it mounts
  or builds from (stack.STACK_FILES, same relative paths as in the repo);
- `node-agent.sha256` — SHA256 of `/app/quickstart-assets/umiak-node-linux-amd64`
  inside `ghcr.io/belov38/umiak-quickstart:<version>`. The installer extracts
  the binary from the pulled image and refuses it unless it matches this
  value, so a re-tagged image cannot plant a different root-run node-agent.

install.sh performs the same download for the first run; this module serves
Update and keeps the format in one place.
"""

import hashlib
import io
import os
import re
import shutil
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .pve import InstallerError

REPO = "belov38/umiak"
VERSION = re.compile(r"[0-9][0-9A-Za-z.+-]{0,63}")
SHA = re.compile(r"[0-9a-f]{64}")
BUNDLE_ROOT = Path(__file__).resolve().parent.parent


class ReleaseError(InstallerError):
    pass


@dataclass(frozen=True)
class Release:
    version: str
    root: Path

    @property
    def node_agent_sha256(self) -> str:
        try:
            value = (self.root / "node-agent.sha256").read_text().split()[0]
        except (FileNotFoundError, IndexError) as error:
            raise ReleaseError("The release bundle has no node-agent checksum") from error
        if not SHA.fullmatch(value):
            raise ReleaseError("Invalid node-agent checksum in the release bundle")
        return value


def valid_version(version: str) -> str:
    if not isinstance(version, str) or not VERSION.fullmatch(version) or ".." in version:
        raise ReleaseError("Invalid release version: " + repr(version))
    return version


def asset_url(version: str, name: str) -> str:
    return f"https://github.com/{REPO}/releases/download/v{valid_version(version)}/{name}"


def bundle_name(version: str) -> str:
    return f"umiak-installer-{valid_version(version)}.tar.gz"


def _https_only(url: str) -> None:
    if not url.startswith("https://"):
        raise ReleaseError("Refusing a non-HTTPS release URL")


def _fetch(url: str) -> bytes:
    _https_only(url)
    with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 - https enforced above
        _https_only(response.geturl())
        return response.read()


def _resolve(url: str) -> str:
    _https_only(url)
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - https enforced above
        return response.geturl()


def latest_version(resolve=_resolve) -> str:
    """The latest published release, from GitHub's /releases/latest redirect (no API rate limit)."""
    final = resolve(f"https://github.com/{REPO}/releases/latest")
    match = re.fullmatch(rf"https://github\.com/{re.escape(REPO)}/releases/tag/v([^/?#]+)", final)
    if not match:
        raise ReleaseError("Could not determine the latest Umiak release")
    return valid_version(match.group(1))


def expected_sha(sums: str, name: str) -> str:
    found = [line.split()[0] for line in sums.splitlines()
             if len(line.split()) == 2 and line.split()[1].lstrip("*") == name]
    if len(found) != 1 or not SHA.fullmatch(found[0]):
        raise ReleaseError(f"Missing or ambiguous SHA256SUMS entry for {name}")
    return found[0]


def _extract(data: bytes, target: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            name = Path(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise ReleaseError("Unsafe entry in release bundle: " + member.name)
        archive.extractall(target, filter="data")


def download(version: str, dest_root: Path, fetch=_fetch) -> Release:
    """Download, verify and unpack `version` into dest_root/<version> (replacing it)."""
    version = valid_version(version)
    name = bundle_name(version)
    data = fetch(asset_url(version, name))
    sums = fetch(asset_url(version, "SHA256SUMS")).decode()
    if hashlib.sha256(data).hexdigest() != expected_sha(sums, name):
        raise ReleaseError("Checksum verification failed for " + name)
    dest_root = Path(dest_root)
    dest_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=dest_root, prefix=".unpack-"))
    try:
        _extract(data, staging)
        found = (staging / "VERSION").read_text().strip() if (staging / "VERSION").exists() else ""
        if found != version:
            raise ReleaseError(f"Bundle version {found!r} does not match release {version}")
        target = dest_root / version
        if target.exists():
            shutil.rmtree(target)
        os.replace(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return Release(version, target)


def current(root: Path = BUNDLE_ROOT) -> Release:
    """The bundle this installer runs from."""
    try:
        version = (Path(root) / "VERSION").read_text().strip()
    except FileNotFoundError as error:
        raise ReleaseError("Run the installer from a release bundle (VERSION file missing)") from error
    return Release(valid_version(version), Path(root))
