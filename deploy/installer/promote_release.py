"""Repackage a verified edge bundle without rebuilding its images or installer."""
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

from build_bundle import write_archive
from umiak_installer.release import bundle_name, compose_images, expected_sha, release_channel


def repack(data: bytes, source: str, target: str) -> bytes:
    if release_channel(source) != "edge" or release_channel(target) != "stable" or source.split("-")[0] != target:
        raise ValueError("Promotion must keep the edge release's version base")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if member.isdir():
                continue
            if not member.isfile() or Path(member.name).is_absolute() or ".." in Path(member.name).parts:
                raise ValueError("Unsafe bundle entry")
            files[member.name] = archive.extractfile(member).read()
    if files.get("VERSION", b"").decode().strip() != source:
        raise ValueError("Wrong source bundle version")
    files["VERSION"] = (target + "\n").encode()
    files["compose.yaml"] = files["compose.yaml"].replace((":" + source).encode(), (":" + target).encode())
    if "release.json" in files:
        metadata = json.loads(files["release.json"])
        if "images" in metadata:
            metadata["images"] = compose_images(files["compose.yaml"].decode(), target)
            files["release.json"] = (json.dumps(metadata, separators=(",", ":")) + "\n").encode()
    return write_archive(files)


if __name__ == "__main__":
    source, target, directory = sys.argv[1:]
    root = Path(directory)
    data = (root / bundle_name(source)).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha((root / "SHA256SUMS").read_text(), bundle_name(source)):
        raise ValueError("Source checksum mismatch")
    result = repack(data, source, target)
    (root / bundle_name(target)).write_bytes(result)
    (root / "SHA256SUMS").write_text(f"{hashlib.sha256(result).hexdigest()}  {bundle_name(target)}\n")
