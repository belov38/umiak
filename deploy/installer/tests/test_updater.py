from datetime import datetime

import pytest

from umiak_installer import updater
from umiak_installer.pve import InstallerError


def test_window_crosses_midnight_and_excludes_end():
    assert updater.in_window("23:00", "02:00", datetime(2026, 11, 5, 0, 30))
    assert not updater.in_window("23:00", "02:00", datetime(2026, 11, 5, 2, 0))
    with pytest.raises(InstallerError):
        updater.validate_settings({"channel": "edge", "start": "25:00"})
    with pytest.raises(InstallerError):
        updater.validate_settings({"channel": "beta"})
    with pytest.raises(InstallerError):
        updater.validate_settings({"auto": "true"})


class Backend:
    def __init__(self, *, backup_error=False, fail=False, compatible=False):
        self.calls = []
        self.saved = None
        self.backup_error, self.fail, self.compatible = backup_error, fail, compatible
    def fence(self):
        self.calls.append("fence")
    def unfence(self):
        self.calls.append("unfence")
    def backup(self):
        self.calls.append("backup")
        if self.backup_error:
            raise InstallerError("disk full")
        return "snapshot"
    def apply(self):
        self.calls.append("apply")
        if self.fail:
            raise InstallerError("unhealthy")
    def rollback(self, backup, restore_data):
        self.calls.append(("rollback", backup, restore_data))
    def checkpoint(self, value):
        self.saved = value
    def history(self, value):
        self.calls.append(value["status"])
    def retain(self):
        self.calls.append("retain")


def test_backup_failure_never_applies_and_clears_fence():
    backend = Backend(backup_error=True)
    with pytest.raises(InstallerError):
        updater.transaction(backend)
    assert "apply" not in backend.calls
    assert "failed" in backend.calls
    assert backend.calls[-1] == "unfence"


@pytest.mark.parametrize("compatible", [True, False])
def test_rollback_and_data_loss_marker(compatible):
    backend = Backend(fail=True, compatible=compatible)
    result = updater.transaction(backend)
    assert ("rollback", "snapshot", not compatible) in backend.calls
    assert result["status"] == "rolled_back"
    assert result["dataLoss"] is (not compatible)
    assert backend.saved is None


def test_success_retains_backups_and_clears_checkpoint():
    backend = Backend()
    assert updater.transaction(backend)["status"] == "updated"
    assert backend.calls.index("backup") < backend.calls.index("apply")
    assert "retain" in backend.calls
    assert backend.saved is None


def test_action_lock_excludes_other_installer_actions(tmp_path):
    from umiak_installer.pve import Runner
    runner = Runner(tmp_path)
    with updater.action_lock(runner):
        with pytest.raises(InstallerError, match="Another installer"):
            with updater.action_lock(runner):
                pytest.fail("lock was not exclusive")


def test_retain_keeps_last_three_complete_backups(tmp_path, monkeypatch):
    from umiak_installer import backup
    monkeypatch.setattr(backup, "BASE", tmp_path)
    for n in range(5):
        directory = tmp_path / str(n)
        directory.mkdir()
        (directory / "metadata.json").write_text('{"complete":true}')
    (tmp_path / "incomplete").mkdir()
    backup.retain()
    assert {p.name for p in tmp_path.iterdir()} == {"2", "3", "4", "incomplete"}


def test_failed_restore_keeps_checkpoint_and_fence():
    backend = Backend(fail=True)
    def broken(*args, **kwargs):
        raise InstallerError("restore failed")
    backend.rollback = broken
    with pytest.raises(InstallerError, match="restore failed"):
        updater.transaction(backend)
    assert backend.saved is not None
    assert "unfence" not in backend.calls


def test_checkpoint_cleared_only_after_unfence():
    backend = Backend()
    original = backend.checkpoint
    def checkpoint(value):
        if value is None:
            assert "unfence" in backend.calls
        original(value)
    backend.checkpoint = checkpoint
    updater.transaction(backend)


def test_timer_uses_target_release_installer_not_running_code(tmp_path):
    from umiak_installer import release, update_timer
    from umiak_installer.pve import Runner
    source = tmp_path / "bundle"
    (source / "umiak_installer").mkdir(parents=True)
    (source / "umiak_installer" / "__main__.py").write_text("# next release")
    (source / "VERSION").write_text("1.9.0\n")
    class Fake(Runner):
        def run(self, argv, input=None):
            return ""
    runner = Fake(tmp_path / "host")
    update_timer.install(runner, release.Release("1.9.0", source))
    runtime = runner.path(updater.ROOT) / "runtime/1.9.0"
    assert (runtime / "umiak_installer/__main__.py").read_text() == "# next release"
    assert "runtime/1.9.0" in runner.path("/etc/systemd/system/umiak-update.service").read_text()


def test_automatic_update_does_not_repeat_a_failed_rollout():
    history=[{"from":"1.0.0","to":"1.1.0","status":"rolled_back"}]
    assert updater.quarantined("1.0.0","1.1.0",history)
    assert not updater.quarantined("1.0.0","1.2.0",history)


@pytest.mark.parametrize("stage", ["preparing", "applying"])
def test_restart_recovers_checkpoint_before_any_new_update(tmp_path,monkeypatch,stage):
    import dataclasses

    from test_state import sample
    from umiak_installer.pve import Runner
    runner=Runner(tmp_path)
    path=runner.path(updater.ROOT) / "update-checkpoint.json"
    updater.atomic_json(path,{"current":dataclasses.asdict(sample(phase="complete")),"target":"1.3.0",
                              "stage":stage,"backup":"snapshot","restoreData":True})
    backend=Backend()
    backend.helper=backend.calls.append
    monkeypatch.setattr(updater,"HostBackend",lambda *args,**kwargs:backend)
    updater.recover(runner,ui=None,state_path=tmp_path / "state",sleep=lambda _:None)
    if stage=="preparing":
        assert "resume" in backend.calls
        assert not any(isinstance(c,tuple) for c in backend.calls)
    else:
        assert ("rollback","snapshot",True) in backend.calls
    assert "unfence" in backend.calls
    assert backend.saved is None


def test_busy_template_build_is_a_skip_without_backup_or_restart(tmp_path,monkeypatch):
    import json

    from test_state import sample
    from umiak_installer import day2, release
    from umiak_installer.pve import CommandError, Runner
    calls = []
    class Fake(Runner):
        def hostname(self):return "pve"
        def run(self,argv,input=None):
            calls.append(argv)
            return ""
    runner=Fake(tmp_path)
    runner.path(day2.SECRETS_DIR).mkdir(parents=True)
    monkeypatch.setattr(day2,"_umiak_ct",lambda *args:{"tags":"umiak"})
    class UI:
        def say(self,line):pass
    (tmp_path / "compose.yaml").write_text("services:\n  api:\n    image: ghcr.io/belov38/umiak-spa:1.3.0\n")
    backend=updater.HostBackend(runner,sample(phase="complete"),release.Release("1.3.0",tmp_path),
                                ui=UI(),state_path=tmp_path / "state",sleep=lambda _:None)
    class Console:
        def call(self,op="read",**data):
            if op=="fence":
                raise CommandError(["node"],1,stderr="A template build is running; skipping update")
            return {}
    backend.console=Console()
    with pytest.raises(updater.UpdateSkipped):
        backend.fence()
    assert [c[-1] for c in calls if "pull" in c] == ["ghcr.io/belov38/umiak-spa:1.3.0"]
    assert not backend.path.exists()
    history=runner.path(updater.ROOT) / "update-history.jsonl"
    assert json.loads(history.read_text())["status"]=="skipped"
