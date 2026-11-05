import runpy
from pathlib import Path
from types import SimpleNamespace


def test_literal_pre_bridge_entrypoint_has_no_min_updater_gate():
    calls = []
    target = SimpleNamespace(version="9.0.0", minUpdater="99.0.0")
    def backend(*args, **kwargs):
        calls.append("backend constructed without checking minUpdater")
        return SimpleNamespace(result=target)
    archived = runpy.run_path(str(Path(__file__).with_name("fixtures") / "pre_bridge_run_update.py"),
                             init_globals={"HostBackend": backend, "transaction": lambda b: {"status": "updated"}})
    result = archived["run_update"](None, None, target, ui=None, state_path=None, sleep=None)
    assert result is target
    assert calls == ["backend constructed without checking minUpdater"]
