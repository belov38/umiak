import json
import sys

import pytest

from umiak_installer import pull_progress
from umiak_installer.pve import CommandError, Runner

REAL_LAYER_SIZES = pull_progress.layer_sizes  # conftest stubs it per test


def event(layer, text, **extra):
    return json.dumps({"id": layer, "parent_id": "Image x", "status": "Working", "text": text, **extra})


def test_progress_reports_bytes_percent_speed_and_time_left():
    now = [0.0]
    said = []
    progress = pull_progress.PullProgress({"aaa": 600_000_000, "bbb": 400_000_000, "ccc": 50_000_000},
                                          said.append, clock=lambda: now[0], every=10)
    progress.feed(json.dumps({"id": "Image x", "status": "Working", "text": "Pulling"}))
    progress.feed(event("ccc", "Already exists"))
    progress.feed(event("ccc", "Pull complete"))  # containerd reports cached layers as complete too
    progress.feed(event("zzz", "Downloading", current=10**9, total=10**9))  # not a layer of this manifest
    now[0] = 5
    progress.feed(event("aaa", "Downloading", current=100_000_000, total=600_000_000))
    assert said == []  # throttled
    now[0] = 10
    progress.feed(event("bbb", "Download complete"))
    assert said == ["  500 MB of 1.0 GB (50%) · 50 MB/s · about 10 s left"]


def test_progress_without_manifest_shows_bytes_and_speed():
    now = [0.0]
    said = []
    progress = pull_progress.PullProgress(None, said.append, clock=lambda: now[0], every=10)
    now[0] = 20
    progress.feed(event("aaa", "Downloading", current=200_000_000, total=300_000_000))
    progress.feed("not json")
    assert said == ["  200 MB downloaded · 10 MB/s"]


def test_plain_docker_pull_lines_count_completed_layers():
    now = [0.0]
    said = []
    progress = pull_progress.PullProgress({"0123456789ab": 300_000_000, "ba9876543210": 100_000_000},
                                          said.append, clock=lambda: now[0], every=10)
    progress.feed("1.3.0: Pulling from belov38/umiak-quickstart")
    progress.feed("ba9876543210: Already exists")
    now[0] = 10
    progress.feed("0123456789ab: Download complete")
    assert said == ["  300 MB of 300 MB (100%) · 30 MB/s"]


def test_no_status_line_before_anything_is_known():
    said = []
    progress = pull_progress.PullProgress(None, said.append, clock=lambda: 99.0, every=10)
    progress.started = 0.0
    progress.feed("0123456789ab: Pulling fs layer")
    assert said == []


def test_human_formats():
    assert pull_progress.human_size(665_000_000) == "665 MB"
    assert pull_progress.human_size(1_240_000_000) == "1.2 GB"
    assert pull_progress.human_duration(0.2) == "1 s"
    assert pull_progress.human_duration(150) == "2 min"


@pytest.mark.parametrize(("image", "expected"), [
    ("postgres:18.6-alpine", ("registry-1.docker.io", "library/postgres", "18.6-alpine")),
    ("ghcr.io/belov38/umiak-quickstart:0.4.0", ("ghcr.io", "belov38/umiak-quickstart", "0.4.0")),
    ("localhost:5000/a/b", ("localhost:5000", "a/b", "latest")),
    ("ghcr.io/a/b@sha256:abc", ("ghcr.io", "a/b", "sha256:abc")),
])
def test_reference(image, expected):
    assert pull_progress._reference(image) == expected


def test_layer_sizes_is_best_effort(monkeypatch):
    def boom(*_args, **_kwargs):
        raise OSError("offline")

    monkeypatch.setattr(pull_progress.urllib.request, "urlopen", boom)
    assert REAL_LAYER_SIZES("ghcr.io/a/b:1") is None


def test_runner_stream_yields_lines_and_reports_failure():
    lines = []
    Runner().stream([sys.executable, "-u", "-c", "import sys; print('a'); print('b', file=sys.stderr)"], lines.append)
    assert lines == ["a", "b"]
    with pytest.raises(CommandError) as failed:
        Runner().stream([sys.executable, "-c", "print('why'); raise SystemExit(3)"], lambda _l: None)
    assert failed.value.returncode == 3 and "why" in failed.value.stderr
