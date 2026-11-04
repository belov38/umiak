import pytest

from umiak_installer import ct


@pytest.fixture(autouse=True)
def _no_probe_wait(monkeypatch):
    monkeypatch.setattr(ct, "PROBE_WAIT", 0)
