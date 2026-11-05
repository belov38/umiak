"""CT-local backup helper, sent by the host over pct stdin. Stdlib only.

No host mounts or credentials are added. Backup data stays root-only inside the
CT; only bounded metadata is returned to the host. Never back up PostgreSQL's
live data directory with tar: pg_dump provides the consistent logical snapshot.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

BASE = Path("/var/lib/umiak-backups")
CONFIG = Path("/opt/umiak")
COMPOSE = ["docker", "compose", "--project-directory", "/opt/umiak"]
WRITERS = ["quickstart", "worker", "api", "web", "mcp", "gateway", "gateway-renewal", "web-meta"]
VOLUMES = ["database-secret", "secrets", "gateway-secrets", "network-config", "pve-secrets"]


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def volume_path(name):
    result = subprocess.check_output(["docker", "volume", "inspect", "umiak_" + name, "--format", "{{.Mountpoint}}"], text=True)
    path = Path(result.strip())
    if not path.is_absolute() or not path.is_dir():
        raise RuntimeError("Missing state volume")
    return path


def stop():
    run(COMPOSE + ["stop", "--timeout", "30", *WRITERS], stdout=sys.stderr)


def backup(identity, release):
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    BASE.chmod(0o700)
    target = BASE / identity
    paths = {name: volume_path(name) for name in VOLUMES}
    size = int(subprocess.check_output(COMPOSE + ["exec", "-T", "postgres", "psql", "-U", "umiak", "-d", "umiak", "-Atc", "SELECT pg_database_size(current_database())"], text=True).strip())
    size += sum(p.stat().st_size for root in paths.values() for p in root.rglob("*") if p.is_file())
    # Conservative: an uncompressed dump + state tar and headroom for recovery.
    if shutil.disk_usage(BASE).free < size * 2 + 512 * 1024 * 1024:
        raise RuntimeError("Insufficient disk for a pre-update backup")
    target.mkdir(mode=0o700)
    try:
        stop()
        with (target / "database.dump").open("wb") as output:
            run(COMPOSE + ["exec", "-T", "postgres", "pg_dump", "-U", "umiak", "-d", "umiak", "--format=custom"], stdout=output)
        with (target / "database.dump").open("rb") as source:
            run(COMPOSE + ["exec", "-T", "postgres", "pg_restore", "--list"], stdin=source, stdout=subprocess.DEVNULL)
        with tarfile.open(target / "state.tar", "w") as archive:
            for name, path in paths.items():
                archive.add(path, arcname=name)
        with tarfile.open(target / "compose.tar", "w") as archive:
            archive.add(CONFIG, arcname="umiak")
        checksums = {}
        for name in ("database.dump", "state.tar", "compose.tar"):
            with (target / name).open("rb") as handle:
                checksums[name] = hashlib.file_digest(handle, "sha256").hexdigest()
        (target / "metadata.json").write_text(json.dumps({"release": release, "complete": True, "checksums": checksums}))
        return {"backup": identity, "release": release}
    except BaseException:
        shutil.rmtree(target)
        raise
    finally:
        # No migration/init tasks are run while resuming the old stack.
        run(COMPOSE + ["start", *WRITERS], stdout=sys.stderr)


def restore(identity, restore_data):
    target = BASE / identity
    metadata = json.loads((target / "metadata.json").read_text())
    if metadata.get("complete") is not True:
        raise RuntimeError("Incomplete backup")
    for name in ("database.dump", "state.tar", "compose.tar"):
        with (target / name).open("rb") as handle:
            if hashlib.file_digest(handle, "sha256").hexdigest() != metadata.get("checksums", {}).get(name):
                raise RuntimeError("Backup checksum mismatch; refusing destructive restore")
    stop()
    # Restore configuration even for image-only rollback. It pins old images.
    with tarfile.open(target / "compose.tar") as archive:
        archive.extractall(CONFIG.parent, filter="data")
    if restore_data:
        paths = {name: volume_path(name) for name in VOLUMES}
        with tarfile.open(target / "state.tar") as archive:
            staging = target / "restore"
            if staging.exists():
                shutil.rmtree(staging)
            archive.extractall(staging, filter="data")
            # The data filter intentionally discards ownership. Restore the
            # original numeric IDs from our private archive without following
            # symlinks; cp -a below carries them into the Docker volumes.
            for member in archive.getmembers():
                os.chown(staging / member.name, member.uid, member.gid, follow_symlinks=False)
            for name, path in paths.items():
                for child in path.iterdir():
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                run(["cp", "-a", str(staging / name) + "/.", str(path)], stdout=sys.stderr)
            shutil.rmtree(staging)
        run(COMPOSE + ["exec", "-T", "postgres", "dropdb", "-U", "umiak", "--force", "--if-exists", "umiak"], stdout=sys.stderr)
        run(COMPOSE + ["exec", "-T", "postgres", "createdb", "-U", "umiak", "umiak"], stdout=sys.stderr)
        with (target / "database.dump").open("rb") as source:
            run(COMPOSE + ["exec", "-T", "postgres", "pg_restore", "-U", "umiak", "-d", "umiak", "--exit-on-error"], stdin=source, stdout=sys.stderr)
    run(COMPOSE + ["up", "-d"], stdout=sys.stderr)
    return metadata


def retain():
    complete = sorted((p for p in BASE.glob("*") if p.is_dir() and (p / "metadata.json").is_file()), reverse=True)
    for path in complete[3:]:
        shutil.rmtree(path)
    return {}


if __name__ == "__main__":
    os.umask(0o077)
    request = json.load(sys.stdin)
    identity = request.get("id", "")
    if request["op"] not in ("retain", "resume") and not re.fullmatch(r"[0-9]{14}-[a-f0-9]{12}", identity):
        raise ValueError("Invalid backup identity")
    if request["op"] == "backup":
        result = backup(identity, request["release"])
    elif request["op"] == "restore":
        result = restore(identity, request["restoreData"] is True)
    elif request["op"] == "resume":
        run(COMPOSE + ["start", *WRITERS], stdout=sys.stderr)
        result = {}
    elif request["op"] == "retain":
        result = retain()
    else:
        raise ValueError("Unknown backup operation")
    print(json.dumps(result))
