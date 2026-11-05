import os

import pytest

from umiak_installer import state


def sample(**changes):
    values = {"version": 1, "ct_id": 150, "ct_ip": "192.168.68.90", "node": "pve", "release": "0.1.0",
              "tailnet_host": None, "phase": "prepared"}
    values.update(changes)
    return state.InstallState(**values)


def test_missing_file_loads_none(tmp_path):
    assert state.load(tmp_path / "umiak" / "install-state.json") is None


def test_round_trip(tmp_path):
    path = tmp_path / "umiak" / "install-state.json"
    state.save(sample(phase="complete", tailnet_host="umiak.example.ts.net"), path)
    assert state.load(path) == sample(phase="complete", tailnet_host="umiak.example.ts.net")


def test_atomic_replace_keeps_old_file_on_failure(tmp_path, monkeypatch):
    path = tmp_path / "install-state.json"
    state.save(sample(), path)
    before = path.read_text()

    def broken(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", broken)
    with pytest.raises(OSError):
        state.save(sample(phase="stack-up"), path)
    assert path.read_text() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["install-state.json"]


def test_rejects_unknown_phase(tmp_path):
    with pytest.raises(ValueError):
        sample(phase="half-done")


def test_default_path():
    assert str(state.DEFAULT_PATH) == "/etc/pve/umiak/install-state.json"


def test_legacy_state_defaults_stable_and_auto_off(tmp_path):
    import dataclasses
    import json
    data = dataclasses.asdict(sample())
    del data["channel"]
    del data["auto_update"]
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(data))
    loaded = state.load(path)
    assert loaded.channel == "stable"
    assert loaded.auto_update is False
