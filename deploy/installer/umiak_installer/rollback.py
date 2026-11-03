#!/usr/bin/env python3
# Rollback journal replay for host preparation. Self-contained (stdlib only):
# prepare_host copies this file into its state directory and arms a systemd
# timer that runs it if preparation does not finish; prepare_host also calls
# replay() in-process when it fails. Journal actions:
#   ["command", argv]                      run argv
#   ["file", path, base64|None, mode]      restore file content (None: delete)
#   ["collection", pvesh_path]             delete all rows, then the collection
# Each undone action is removed from the journal (atomic rewrite), so a retry
# resumes where a failed run stopped. An undo whose target is already gone
# counts as done (real pvesh/pveum fail on deleting missing objects), but only
# when a successful read shows it is gone; read errors keep the action.
import base64
import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

LOCK, ACTIVE, JOURNAL, BRIDGE = "prepare.lock", "active", "undo.json", "bridge.json"
TIMER = "umiak-installer-rollback.timer"


def retry_hint(state: Path) -> str:
    # A still-registered timer unit makes the next systemd-run fail, so stop it first.
    return f"systemctl stop {TIMER}; python3 {Path(state) / 'rollback.py'} {state}"


def _subprocess_run(argv):
    return subprocess.run(argv, check=True, text=True, capture_output=True).stdout.strip()


def write_journal(state: Path, actions: list) -> None:
    """Replace the journal atomically (0600): never leave a truncated file."""
    path = Path(state) / JOURNAL
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(json.dumps(actions))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read(run, path):
    return json.loads(run(["pvesh", "get", path, "--output-format", "json"]) or "[]")


def _id_field(parent: str) -> str | None:
    """Which row field names an object inside the listing `parent`."""
    fixed = {
        "/cluster/sdn/zones": "zone",
        "/cluster/sdn/vnets": "vnet",
        "/cluster/firewall/ipset": "name",
        "/cluster/firewall/groups": "group",
        "/access/roles": "roleid",
        "/pools": "poolid",
        "/access/users": "userid",
    }
    if parent in fixed:
        return fixed[parent]
    if parent.startswith("/cluster/sdn/vnets/") and parent.endswith("/subnets"):
        return "subnet"
    if parent.startswith("/access/users/") and parent.endswith("/token"):
        return "tokenid"
    if parent.startswith("/cluster/firewall/ipset/"):
        return "cidr"
    if parent.startswith("/cluster/firewall/groups/"):
        return "pos"
    return None


def _path_absent(run, path: str) -> bool:
    """True only when a read succeeds and shows the object is gone.

    A failed read proves nothing (pmxcfs may be down around a reboot), so it
    raises and the action stays in the journal for the next retry.
    """
    parent, key = path.rsplit("/", 1)
    field = _id_field(parent)
    if field is None:
        raise RuntimeError("Cannot check existence of " + path)
    try:
        rows = _read(run, parent)
    except Exception:
        # Listing a child collection fails when its owner object is gone
        # (VNet for subnets, user for tokens, IPSet/group for their rows).
        owner = parent.removesuffix("/subnets").removesuffix("/token")
        if _id_field(owner.rsplit("/", 1)[0]) is not None and _path_absent(run, owner):
            return True
        raise
    return not any(str(row.get(field)) == key for row in rows)


def _absent(run, argv) -> bool:
    """After a failed undo command: is its target already gone?"""
    if argv[:2] == ["pvesh", "delete"]:
        return _path_absent(run, argv[2])
    if argv[:3] == ["pveum", "role", "delete"]:
        return _path_absent(run, "/access/roles/" + argv[3])
    if argv[:3] == ["pveum", "pool", "delete"]:
        return _path_absent(run, "/pools/" + argv[3])
    if argv[:3] == ["pveum", "user", "delete"]:
        return _path_absent(run, "/access/users/" + argv[3])
    if argv[:4] == ["pveum", "user", "token", "remove"]:
        return _path_absent(run, f"/access/users/{argv[4]}/token/{argv[5]}")
    if argv[:3] == ["pveum", "acl", "delete"]:
        path, principal, role = argv[3], argv[5], argv[7]
        acls = _read(run, "/access/acl")
        return not any(x.get("path") == path and x.get("ugid") == principal and x.get("roleid") == role for x in acls)
    return False


def _undo(action, run) -> None:
    if action[0] == "command":
        try:
            run(action[1])
        except Exception:
            if not _absent(run, action[1]):
                raise
    elif action[0] == "file":
        path = Path(action[1])
        if action[2] is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(base64.b64decode(action[2]))
            path.chmod(action[3])
    elif action[0] == "collection":
        path = action[1]
        if _path_absent(run, path):  # raises when the cluster cannot be read
            return
        for row in sorted(_read(run, path), key=lambda row: int(row.get("pos", 0)), reverse=True):
            run(["pvesh", "delete", path + "/" + str(row.get("cidr", row.get("pos")))])
        run(["pvesh", "delete", path])


def replay(state: Path, run=_subprocess_run) -> None:
    """Undo journaled actions newest first; the caller must hold the lock."""
    state = Path(state)
    if not (state / ACTIVE).exists():
        return
    journal = state / JOURNAL
    actions = json.loads(journal.read_text()) if journal.exists() else []
    failed = False
    for index in range(len(actions) - 1, -1, -1):
        action = actions[index]
        try:
            _undo(action, run)
        except Exception:  # noqa: BLE001 - keep undoing the rest, report at the end
            failed = True
            print("Rollback action failed:", action[0], file=sys.stderr)
            continue
        del actions[index]
        write_journal(state, actions)
    # Re-apply SDN so removed Umiak objects leave the running configuration.
    for step in (lambda: run(["pvesh", "set", "/cluster/sdn"]), lambda: restore_bridge(state, run)):
        try:
            step()
        except Exception:  # noqa: BLE001 - keep ACTIVE so the retry applies again
            failed = True
            print("Rollback SDN apply or bridge restore failed", file=sys.stderr)
    if failed:
        raise RuntimeError("Rollback incomplete; inspect failures and retry with: " + retry_hint(state))
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


def main(state: str, run=_subprocess_run) -> None:
    # The timer waits for the preparing process's lock: a slow but successful
    # run clears ACTIVE before releasing it, so nothing is rolled back then.
    with (Path(state) / LOCK).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        replay(Path(state), run)


if __name__ == "__main__":
    main(sys.argv[1])
