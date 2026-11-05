"""Host-owned update policy and recoverable backup/apply/rollback transaction."""
import contextlib
import dataclasses
import fcntl
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .pve import InstallerError, private_dir, write_secret

CLOCK = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
ROOT = "/var/lib/umiak-installer"


def validate_settings(value):
    defaults = {"channel": "stable", "auto": False, "paused": False, "start": "03:00", "end": "04:00"}
    if not isinstance(value, dict) or set(value) - set(defaults):
        raise InstallerError("Invalid update settings")
    result = defaults | value
    if result["channel"] not in ("stable", "edge") or any(type(result[k]) is not bool for k in ("auto", "paused")):
        raise InstallerError("Invalid update channel or mode")
    if any(not isinstance(result[k], str) or not CLOCK.fullmatch(result[k]) for k in ("start", "end")):
        raise InstallerError("Window must use HH:MM host local time")
    if result["start"] == result["end"]:
        raise InstallerError("Maintenance window must have a nonzero duration")
    return result


def in_window(start, end, now=None):
    validate_settings({"start": start, "end": end})
    clock = (now or datetime.now()).strftime("%H:%M")
    return start <= clock < end if start < end else clock >= start or clock < end


@contextlib.contextmanager
def action_lock(runner):
    path = runner.path(ROOT) / "action.lock"
    private_dir(path.parent)
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallerError("Another installer action is running; skipping") from error
        yield


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def transaction(backend):
    """The checkpoint remains until successful update or verified rollback.

    A failure to restore is deliberately fatal and leaves the checkpoint/fence
    for the next host run. Never label an attempted restore as a rollback.
    """
    backend.fence()
    record = {"startedAt": timestamp(), "status": "failed", "dataLoss": False}
    fenced = True
    try:
        backup = backend.backup()
        record["backup"] = backup
        backend.checkpoint({"backup": backup, "restoreData": not backend.compatible})
        try:
            backend.apply()
        except Exception:
            fenced = False
            record["dataLoss"] = not backend.compatible
            backend.rollback(backup, restore_data=not backend.compatible)
            fenced = True
            record.update(status="rolled_back", dataLoss=not backend.compatible)
            if record["dataLoss"]:
                record["message"] = "Pre-update database and state restored; writes since backup were lost."
        else:
            record["status"] = "updated"
        backend.history(record | {"finishedAt": timestamp()})
        backend.unfence()
        fenced = False
        backend.checkpoint(None)
        try:
            backend.retain()
        except Exception:
            backend.history(record | {"status": "warning", "message": "Update finished but backup retention failed; inspect the host journal."})
        return record
    except Exception:
        backend.history(record | {"finishedAt": timestamp(), "message": "Update failed; inspect host updater journal and recovery checkpoint."})
        raise
    finally:
        if fenced:
            backend.unfence()


def atomic_json(path, value):
    path = Path(path)
    private_dir(path.parent)
    temporary = path.with_suffix(".tmp")
    write_secret(temporary, json.dumps(value) + "\n")
    import os
    with temporary.open("rb") as handle:
        os.fsync(handle.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class HostBackend:
    def __init__(self, runner, current, bundle, *, ui, state_path, sleep):
        from .update_console import Console
        self.runner, self.current, self.bundle = runner, current, bundle
        self.ui, self.state_path, self.sleep = ui, state_path, sleep
        self.console = Console(runner, current)
        self.compatible = bundle.db_compatible
        self.path = runner.path(ROOT) / "update-checkpoint.json"
        self.source = None
        self.result = current

    def fence(self):
        from . import day2
        day2._require_node(self.runner, self.current)
        day2._require_complete(self.current)
        if day2._umiak_ct(self.runner, self.current.ct_id) is None:
            raise InstallerError("Recorded Umiak CT is missing")
        from .ct import run_in
        # Pull immutable release tags before fencing template work or stopping
        # writers. Downloads dominate update duration on a home connection.
        self.ui.say("Pulling the release images before maintenance…")
        for name in ("quickstart", "web"):
            run_in(self.runner, self.current.ct_id, "docker", "pull",
                   f"ghcr.io/belov38/umiak-{name}:{self.bundle.version}")
        import hashlib
        import shutil
        from . import release, day2, prepare_host
        recovery = self.runner.path(ROOT) / "recovery"
        private_dir(recovery)
        secrets = self.runner.path(day2.SECRETS_DIR)
        shutil.copytree(secrets, recovery / "secrets", dirs_exist_ok=True)
        binary = self.runner.path(prepare_host.NODE_BINARY)
        if binary.is_file():
            shutil.copy2(binary, recovery / "node-agent")
            write_secret(recovery / "node-agent.sha256", hashlib.sha256(binary.read_bytes()).hexdigest())
            self.source = release.Release(self.current.release, recovery)
        self.checkpoint({"stage": "preparing", "backup": "", "restoreData": True})
        self.console.call("fence", status={"version": self.current.release, "channel": self.current.channel,
                                          "updating": True, "message": "Updating Umiak…"})

    def unfence(self):
        self.console.call("unfence", status={"version": self.result.release, "channel": self.result.channel, "updating": False})

    def helper(self, op, **data):
        from .ct import run_in
        script = Path(__file__).with_name("backup.py").read_text()
        return json.loads(run_in(self.runner, self.current.ct_id, "python3", "-c", script,
                                 input=json.dumps(dict(data, op=op))))

    def backup(self):
        import secrets
        identity = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(6)
        self.ui.say("Backing up the database and state (control plane briefly unavailable)…")
        self.helper("backup", id=identity, release=self.current.release)
        self.helper("retain")
        return identity

    def apply(self):
        from . import day2
        self.result = day2.update(self.runner, self.current, self.bundle, ui=self.ui,
                                  sleep=self.sleep, state_path=self.state_path)

    def rollback(self, backup, restore_data):
        import shutil
        from . import day2, nodes, prepare_host, stack, state
        self.ui.say("Restoring the previous control plane…")
        self.helper("restore", id=backup, restoreData=restore_data)
        recovery = self.runner.path(ROOT) / "recovery"
        shutil.copytree(recovery / "secrets", self.runner.path(day2.SECRETS_DIR), dirs_exist_ok=True)
        # Image-only rollback retains new owner data, but installer facts must
        # describe the restored image rather than the failed target release.
        stack.push_secrets(self.runner, self.current.ct_id,
                           {"install.json": self.runner.path(day2.SECRETS_DIR) / "install.json"},
                           stack.quickstart_image(self.current.release))
        stack.restart(self.runner, self.current.ct_id, "quickstart")
        stack.wait_healthy(self.runner, self.current.ct_id, sleep=self.sleep)
        stack.wait_bootstrap(self.runner, self.current.ct_id, sleep=self.sleep)
        if self.source:
            public = (self.runner.path(day2.SECRETS_DIR) / "umiak-node_ed25519.pub").read_text().strip()
            prepare_host.install_node_agent(self.runner, recovery / "node-agent", self.source.node_agent_sha256, public)
            # Refresh restricted node agents from the same verified old image.
            nodes.refresh_agents(self.runner, self.current, self.source, ui=self.ui)
        self.result = self.current
        state.save(self.current, self.state_path)

    def checkpoint(self, value):
        if value is None:
            self.path.unlink(missing_ok=True)
        else:
            atomic_json(self.path, value | {"stage": value.get("stage", "applying"), "current": dataclasses.asdict(self.current),
                                           "target": self.bundle.version})

    def history(self, record):
        record = record | {"from": self.current.release, "to": self.bundle.version}
        # Host journal survives a broken DB and a database restore.
        path = self.runner.path(ROOT) / "update-history.jsonl"
        private_dir(path.parent)
        with path.open("a") as handle:
            import os
            os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            self.console.call(record=record)
        except Exception:
            self.ui.say("Update history is in the host journal; control-plane history is unavailable.")

    def retain(self):
        self.helper("retain")


def recover(runner, *, ui, state_path, sleep):
    """A surviving checkpoint means an interrupted apply: restore conservatively."""
    from . import release, state
    path = runner.path(ROOT) / "update-checkpoint.json"
    if not path.exists():
        return
    saved = json.loads(path.read_text())
    current = state.InstallState(**saved["current"])
    backend = HostBackend(runner, current, release.Release(saved["target"], Path("/nonexistent")),
                          ui=ui, state_path=state_path, sleep=sleep)
    source = runner.path(ROOT) / "recovery"
    if (source / "node-agent.sha256").exists():
        backend.source = release.Release(current.release, source)
    if saved.get("stage") == "preparing":
        backend.helper("resume")
        backend.history({"status": "failed", "message": "Resumed previous control plane after interrupted backup preparation.",
                         "finishedAt": timestamp(), "dataLoss": False})
        backend.checkpoint(None)
        backend.unfence()
        return
    backend.rollback(saved["backup"], restore_data=saved["restoreData"])
    backend.history({"status": "rolled_back", "dataLoss": saved["restoreData"],
                     "message": "Recovered interrupted host update; writes since backup may be lost.",
                     "finishedAt": timestamp(), "backup": saved["backup"]})
    backend.unfence()
    backend.checkpoint(None)


def run_update(runner, current, bundle, *, ui, state_path, sleep):
    backend = HostBackend(runner, current, bundle, ui=ui, state_path=state_path, sleep=sleep)
    record = transaction(backend)
    if record["status"] != "updated":
        raise InstallerError("Update failed; previous release restored. See update history.")
    return backend.result


def release_newer(candidate, running):
    from .release import version_key
    return version_key(candidate) > version_key(running)
