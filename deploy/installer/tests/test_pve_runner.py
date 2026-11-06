import subprocess

import pytest

from umiak_installer import pve


class Recorder:
    def __init__(self, codes):
        self.codes = list(codes)
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, self.codes.pop(0), "out\n", "err")


def make(monkeypatch, codes):
    recorder = Recorder(codes)
    monkeypatch.setattr(pve.subprocess, "run", recorder)
    sleeps = []
    return pve.Runner(sleep=sleeps.append), recorder, sleeps


def test_commands_never_inherit_the_terminal(monkeypatch):
    runner, recorder, _ = make(monkeypatch, [0, 0])
    runner.run(["pvesh", "get", "/nodes"])
    runner.run(["pct", "exec", "590", "--", "sh", "-c", "cat"], input="data")
    (_, plain), (_, fed) = recorder.calls
    assert plain["stdin"] is subprocess.DEVNULL and plain["input"] is None
    assert fed["stdin"] is None and fed["input"] == "data"


def test_pct_exec_retries_a_hung_up_attach(monkeypatch):
    runner, recorder, sleeps = make(monkeypatch, [129, 129, 0])
    assert runner.run(["pct", "exec", "590", "--", "install", "-d", "/x"]) == "out"
    assert len(recorder.calls) == 3 and sleeps == [pve.RETRY_DELAY_S] * 2


def test_pct_exec_gives_up_after_the_last_attempt(monkeypatch):
    runner, recorder, _ = make(monkeypatch, [129] * pve.PCT_EXEC_ATTEMPTS)
    with pytest.raises(pve.CommandError, match="exit code 129"):
        runner.run(["pct", "exec", "590", "--", "true"])
    assert len(recorder.calls) == pve.PCT_EXEC_ATTEMPTS


@pytest.mark.parametrize("argv,code", [(["pct", "exec", "590", "--", "false"], 1), (["pvesh", "get", "/"], 129)])
def test_other_failures_are_not_retried(monkeypatch, argv, code):
    runner, recorder, sleeps = make(monkeypatch, [code])
    with pytest.raises(pve.CommandError):
        runner.run(argv)
    assert len(recorder.calls) == 1 and sleeps == []
