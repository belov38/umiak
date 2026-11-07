import pytest

from umiak_installer import ct


@pytest.fixture(autouse=True)
def _no_probe_wait(monkeypatch):
    monkeypatch.setattr(ct, "PROBE_WAIT", 0)


@pytest.fixture(autouse=True)
def _no_registry_lookup(monkeypatch):
    from umiak_installer import pull_progress

    monkeypatch.setattr(pull_progress, "layer_sizes", lambda _image: None)
