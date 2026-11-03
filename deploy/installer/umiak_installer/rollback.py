#!/usr/bin/env python3
# Rollback journal replay for host preparation. Self-contained (stdlib only):
# prepare_host copies this file into its state directory and arms a systemd
# timer that runs it if preparation does not finish; prepare_host also calls
# replay() in-process when it fails. Journal actions:
#   ["command", argv]                      run argv
#   ["file", path, base64|None, mode]      restore file content (None: delete)
#   ["collection", pvesh_path]             delete all rows, then the collection
import base64
import fcntl
import json
import subprocess
import sys
from pathlib import Path

LOCK, ACTIVE, JOURNAL, BRIDGE = "prepare.lock", "active", "undo.json", "bridge.json"


def _subprocess_run(argv):
    return subprocess.run(argv, check=True, text=True, capture_output=True).stdout.strip()


def replay(state: Path, run=_subprocess_run) -> None:
    """Undo journaled actions newest first; the caller must hold the lock."""
    state = Path(state)
    if not (state / ACTIVE).exists():
        return
    journal = state / JOURNAL
    actions = json.loads(journal.read_text()) if journal.exists() else []
    failed = False
    for action in reversed(actions):
        try:
            if action[0] == "command":
                run(action[1])
            elif action[0] == "file":
                path = Path(action[1])
                if action[2] is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(base64.b64decode(action[2]))
                    path.chmod(action[3])
            elif action[0] == "collection":
                path = action[1]
                rows = json.loads(run(["pvesh", "get", path, "--output-format", "json"]) or "[]")
                for row in sorted(rows, key=lambda row: int(row.get("pos", 0)), reverse=True):
                    run(["pvesh", "delete", path + "/" + str(row.get("cidr", row.get("pos")))])
                run(["pvesh", "delete", path])
        except Exception:  # noqa: BLE001 - keep undoing the rest, report at the end
            failed = True
            print("Rollback action failed:", action[0], file=sys.stderr)
    # Re-apply SDN so removed Umiak objects leave the running configuration.
    run(["pvesh", "set", "/cluster/sdn"])
    restore_bridge(state, run)
    if failed:
        raise RuntimeError("Rollback incomplete; inspect failures and run rollback.py again")
    (state / ACTIVE).unlink(missing_ok=True)


def restore_bridge(state: Path, run=_subprocess_run) -> None:
    # Proxmox SDN reload may reset ifupdown2's multicast hash default on vmbr0.
    # Restore only the value saved before our change; never rewrite bridge config.
    saved = Path(state) / BRIDGE
    if not saved.exists():
        return
    bridge = json.loads(saved.read_text())
    if not bridge.get("value"):
        return
    current = Path(bridge["path"])
    if not current.exists() or current.read_text().strip() != bridge["value"]:
        run(["ip", "link", "set", "dev", "vmbr0", "type", "bridge", "mcast_hash_max", bridge["value"]])


def main(state: str) -> None:
    # The timer waits for the preparing process's lock: a slow but successful
    # run clears ACTIVE before releasing it, so nothing is rolled back then.
    with (Path(state) / LOCK).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        replay(Path(state))


if __name__ == "__main__":
    main(sys.argv[1])
