import json

import pytest

from umiak_installer import backup


@pytest.fixture
def fake_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(backup, "BASE", tmp_path / "backups")
    config = tmp_path / "umiak"
    config.mkdir()
    (config / "compose.yaml").write_text("old images")
    monkeypatch.setattr(backup, "CONFIG", config)
    volumes = {}
    for name in backup.VOLUMES:
        path = tmp_path / name
        path.mkdir()
        (path / "state").write_text(name)
        volumes[name] = path
    monkeypatch.setattr(backup, "volume_path", lambda name: volumes[name])
    def output(argv, **kwargs):
        if "config" in argv:
            names = ["api", "quickstart", "worker", "web", "web-meta"] if (config / "compose.yaml").read_text() == "old images" else ["api", "new-worker"]
            return json.dumps({"services": {"postgres": {}, "migrate": {"restart": "no"},
                                **{name: {"depends_on": {"migrate": {"condition": "service_completed_successfully"}}}
                                   for name in names}}})
        return "100"
    monkeypatch.setattr(backup.subprocess, "check_output", output)
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        if "pg_dump" in argv:
            kwargs["stdout"].write(b"logical dump")

    monkeypatch.setattr(backup, "run", run)
    return calls


def test_backup_stops_only_stack_writers_and_marks_complete(fake_backup):
    result = backup.backup("20261105030000-aaaaaaaaaaaa", "1.2.0")
    assert result["release"] == "1.2.0"
    root = backup.BASE / result["backup"]
    metadata = json.loads((root / "metadata.json").read_text())
    assert metadata["release"] == "1.2.0" and metadata["complete"] is True
    assert set(metadata["checksums"]) == {"database.dump", "state.tar", "compose.tar"}
    assert (root / "database.dump").read_bytes() == b"logical dump"
    stop = next(c for c in fake_backup if "stop" in c)
    assert "postgres" not in stop
    assert fake_backup[-1][-5:] == ["api", "quickstart", "worker", "web", "web-meta"]
    assert all(c[0] == "docker" for c in fake_backup)


def test_dump_failure_resumes_old_stack_and_removes_partial_backup(fake_backup, monkeypatch):
    original = backup.run

    def fail(argv, **kwargs):
        if "pg_dump" in argv:
            raise RuntimeError("dump failed")
        return original(argv, **kwargs)

    monkeypatch.setattr(backup, "run", fail)
    with pytest.raises(RuntimeError, match="dump failed"):
        backup.backup("20261105030000-aaaaaaaaaaaa", "1.2.0")
    assert list(backup.BASE.iterdir()) == []
    assert "start" in fake_backup[-1]


def test_insufficient_disk_refuses_before_stopping_writers(fake_backup, monkeypatch):
    from collections import namedtuple

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(backup.shutil, "disk_usage", lambda p: usage(100, 99, 1))
    with pytest.raises(RuntimeError, match="Insufficient disk"):
        backup.backup("20261105030000-aaaaaaaaaaaa", "1.2.0")
    assert not fake_backup


def test_corrupt_backup_refuses_before_destructive_restore(fake_backup):
    identity = "20261105030000-aaaaaaaaaaaa"
    backup.backup(identity, "1.2.0")
    (backup.BASE / identity / "database.dump").write_bytes(b"corrupt")
    fake_backup.clear()
    with pytest.raises(RuntimeError, match="checksum"):
        backup.restore(identity, True)
    assert not fake_backup


@pytest.mark.parametrize("restore_data", [False, True])
def test_restore_data_only_for_incompatible_migrations(fake_backup, restore_data):
    identity = "20261105030000-aaaaaaaaaaaa"
    backup.backup(identity, "1.2.0")
    fake_backup.clear()
    metadata = backup.restore(identity, restore_data)
    assert metadata["release"] == "1.2.0"
    assert any("dropdb" in c for c in fake_backup) is restore_data
    assert any("pg_restore" in c for c in fake_backup) is restore_data
    assert any("cp" == c[0] and "-a" in c for c in fake_backup) is restore_data


def test_restore_stops_target_services_before_restoring_source_config(fake_backup):
    identity = "20261105030000-aaaaaaaaaaaa"
    backup.backup(identity, "1.2.0")
    (backup.CONFIG / "compose.yaml").write_text("new images without web")
    fake_backup.clear()
    backup.restore(identity, True)
    stop = next(c for c in fake_backup if "stop" in c)
    assert stop[-2:] == ["api", "new-worker"]
    assert "web" not in stop and "web-meta" not in stop
    assert (backup.CONFIG / "compose.yaml").read_text() == "old images"
    assert any("dropdb" in c for c in fake_backup)
    assert any("pg_restore" in c for c in fake_backup)


def test_restore_extraction_keeps_directory_and_file_modes(tmp_path):
    import os
    import stat
    import tarfile

    source = tmp_path / "source" / "gateway-secrets"
    (source / "logs").mkdir(parents=True)
    source.chmod(0o755)
    (source / "logs").chmod(0o711)
    (source / "api-token").write_text("secret")
    (source / "api-token").chmod(0o600)
    (source / "ca.pem").write_text("public")
    (source / "ca.pem").chmod(0o664)
    with tarfile.open(tmp_path / "state.tar", "w") as archive:
        archive.add(source, arcname="gateway-secrets")
    staging = tmp_path / "restore"
    # The host updater runs with a strict umask; the data filter creates
    # directories through it, which is what left them 0700 on a real rollback.
    previous = os.umask(0o077)
    try:
        with tarfile.open(tmp_path / "state.tar") as archive:
            backup.extract_state(archive, staging)
    finally:
        os.umask(previous)
    mode = lambda p: stat.S_IMODE(os.lstat(staging / p).st_mode)
    # Regression: the data filter alone left every directory 0700.
    assert mode("gateway-secrets") == 0o755
    assert mode("gateway-secrets/logs") == 0o711
    assert mode("gateway-secrets/api-token") == 0o600
    assert mode("gateway-secrets/ca.pem") == 0o664
