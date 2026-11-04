"""Build the release bundle `umiak-installer-<version>.tar.gz` and its SHA256SUMS.

usage: build_bundle.py <version> <out_dir> --node-agent-sha256 <hex>

The layout is the one umiak_installer.release unpacks: VERSION, node-agent.sha256,
umiak_installer/** (no tests, no caches) and every stack.STACK_FILES path, with the
compose.yaml images pinned to <version>. The archive is deterministic (sorted
entries, fixed mtime and owner, gzip header without a timestamp).
"""

import argparse
import gzip
import hashlib
import io
import re
import sys
import tarfile
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from umiak_installer import release, stack  # noqa: E402

REPO_ROOT = HERE.parent.parent
VERSION_PLACEHOLDER = "${UMIAK_VERSION:?}"
IMAGE_LINE = re.compile(r"^\s*image: ghcr\.io/belov38/umiak-[a-z-]+:(\S+)$", re.M)


def pinned_compose(text: str, version: str) -> str:
    """compose.yaml with every ${UMIAK_VERSION:?} replaced by the literal version; must be pull-only."""
    if VERSION_PLACEHOLDER not in text:
        raise SystemExit("compose.yaml has no " + VERSION_PLACEHOLDER + " image tags to pin")
    pinned = text.replace(VERSION_PLACEHOLDER, version)
    if re.search(r"^\s*build:", pinned, re.M):
        raise SystemExit("compose.yaml must not contain build: sections")
    if "${UMIAK_VERSION" in pinned:
        raise SystemExit("compose.yaml has an unpinned UMIAK_VERSION reference")
    tags = {m.group(1) for m in IMAGE_LINE.finditer(pinned)}
    if tags != {version}:
        raise SystemExit(f"Umiak images must all carry the tag {version}, found {sorted(tags)}")
    return pinned


def collect(repo: Path, version: str, node_agent_sha256: str) -> dict[str, bytes]:
    files: dict[str, bytes] = {
        "VERSION": (version + "\n").encode(),
        "node-agent.sha256": (node_agent_sha256 + "\n").encode(),
    }
    package = repo / "deploy" / "installer" / "umiak_installer"
    for path in sorted(package.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            files["umiak_installer/" + path.relative_to(package).as_posix()] = path.read_bytes()
    for name in stack.STACK_FILES:
        source = repo / name
        if not source.is_file():
            raise SystemExit("Missing stack file: " + name)
        data = source.read_bytes()
        files[name] = pinned_compose(data.decode(), version).encode() if name == "compose.yaml" else data
    return files


def write_archive(files: dict[str, bytes]) -> bytes:
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz, \
            tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name in sorted(files):
            info = tarfile.TarInfo(name)
            info.size = len(files[name])
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(files[name]))
    return raw.getvalue()


def build(version: str, out_dir: Path, node_agent_sha256: str, repo: Path = REPO_ROOT) -> Path:
    version = release.valid_version(version)
    if not release.SHA.fullmatch(node_agent_sha256):
        raise SystemExit("--node-agent-sha256 must be 64 lowercase hex characters")
    data = write_archive(collect(Path(repo), version, node_agent_sha256))
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = out_dir / release.bundle_name(version)
    bundle.write_bytes(data)
    (out_dir / "SHA256SUMS").write_text(f"{hashlib.sha256(data).hexdigest()}  {bundle.name}\n")
    return bundle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("version")
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--node-agent-sha256", required=True)
    args = parser.parse_args(argv)
    print(build(args.version, args.out_dir, args.node_agent_sha256))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
