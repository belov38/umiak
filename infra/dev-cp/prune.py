"""Prune stale deployment source files, preserving compose secrets and environment."""
from pathlib import Path
import sys

root = Path.home() / "boat-dev-clone"
allowed = set(sys.stdin.read().splitlines())
if "CLAUDE.md" not in allowed or "infra/dev-cp/prune.py" not in allowed:
    raise SystemExit("invalid deployment file inventory")
count = 0
for path in root.rglob("*"):
    relative = path.relative_to(root).as_posix()
    if (path.is_file() or path.is_symlink()) and relative not in allowed:
        if relative.startswith("deploy/compose/secrets/") or relative == "deploy/compose/.env":
            continue
        path.unlink()
        count += 1
print(f"pruned {count} stale files")
