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
