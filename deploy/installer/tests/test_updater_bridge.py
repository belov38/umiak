import json
from pathlib import Path

import pytest

import build_bundle
from umiak_installer import backup, release, updater


def bundle(tmp_path, metadata=None, images=("quickstart",)):
    version = "1.3.0-edge.20261106.2"
    (tmp_path / "compose.yaml").write_text("services:\n" + "".join(
        f"  {name}:\n    image: ghcr.io/belov38/umiak-{name}:{version}\n" for name in images
    ))
    if metadata is not None:
        (tmp_path / "release.json").write_text(json.dumps(metadata))
    return release.Release(version, tmp_path)


def test_legacy_images_come_from_target_compose(tmp_path):
    target = bundle(tmp_path, images=("quickstart", "new-service", "quickstart"))
    assert target.images == [f"ghcr.io/belov38/umiak-{n}:{target.version}" for n in ("quickstart", "new-service")]


def test_new_metadata_images_match_target_compose(tmp_path):
    target = bundle(tmp_path, {"images": ["ghcr.io/belov38/umiak-web:1.3.0"]})
    with pytest.raises(release.ReleaseError):
        _ = target.images


@pytest.mark.parametrize("image", ["evil.example/image:1.3.0", "ghcr.io/belov38/umiak-web:latest", "$(id)"])
def test_unsafe_target_image_is_refused(tmp_path, image):
    target = bundle(tmp_path)
    (tmp_path / "compose.yaml").write_text(f"services:\n  app:\n    image: {image}\n")
    with pytest.raises(release.ReleaseError):
        _ = target.images


@pytest.mark.parametrize("running", ["1.2.0", "1.3.0-edge.20261106.1"])
def test_min_updater_refuses_before_backend_construction(tmp_path, monkeypatch, running):
    target = bundle(tmp_path, {"minUpdater": "1.3.0-edge.20261106.2"})
    monkeypatch.setattr(release, "current", lambda: release.Release(running, tmp_path))
    monkeypatch.setattr(updater, "HostBackend", lambda *a, **k: pytest.fail("update side effect before gate"))
    with pytest.raises(release.ReleaseError, match="update to 1.3.0-edge.20261106.2 first"):
        updater.run_update(None, None, target, ui=None, state_path=None, sleep=None)


@pytest.mark.parametrize("running", ["1.3.0-edge.20261106.2", "1.3.0", "1.4.0"])
def test_min_updater_allows_equal_or_newer_runtime(tmp_path, running):
    target = bundle(tmp_path, {"minUpdater": "1.3.0-edge.20261106.2"})
    target.require_updater(running)


@pytest.mark.parametrize("metadata", [{"minUpdater": None}, {"minUpdater": "bad"}, [], {"images": "bad"}])
def test_malformed_metadata_fails_closed(tmp_path, metadata):
    target = bundle(tmp_path, metadata)
    with pytest.raises(release.ReleaseError):
        target.require_updater("1.3.0")


def test_bundle_declares_images_and_min_updater(tmp_path):
    files = build_bundle.collect(build_bundle.REPO_ROOT, "1.3.0", "ab" * 32, min_updater="1.2.0")
    metadata = json.loads(files["release.json"])
    assert metadata["minUpdater"] == "1.2.0"
    assert metadata["dbCompatible"] is False
    assert metadata["images"] == ["ghcr.io/belov38/umiak-quickstart:1.3.0", "postgres:18.6-alpine"]


def test_backup_discovers_actual_writers_and_skips_removed_services(monkeypatch):
    services = {"postgres": {}, "api": {"depends_on": {"migrate": {"condition": "service_completed_successfully"},
                                                       "secrets-init": {"condition": "service_completed_successfully"}}},
                "new-worker": {"restart": "no"}, "migrate": {"restart": "no"},
                "secrets-init": {"restart": "no"}}
    monkeypatch.setattr(backup.subprocess, "check_output", lambda *a, **k: json.dumps({"services": services}))
    calls = []
    monkeypatch.setattr(backup, "run", lambda argv, **kw: calls.append(argv))
    backup.stop()
    backup.resume()
    assert calls == [backup.COMPOSE + ["stop", "--timeout", "30", "api", "new-worker"],
                     backup.COMPOSE + ["start", "api", "new-worker"]]


def test_promotion_updates_image_manifest_and_retains_requirement():
    import io
    import tarfile
    from promote_release import repack
    from test_release import tarball
    source = "1.3.0-edge.20261106.2"
    image = f"ghcr.io/belov38/umiak-quickstart:{source}"
    data = tarball({"VERSION": source.encode(), "compose.yaml": f"image: {image}\n".encode(),
                    "release.json": json.dumps({"dbCompatible": False, "images": [image],
                                                "minUpdater": "1.2.0"}).encode()})
    with tarfile.open(fileobj=io.BytesIO(repack(data, source, "1.3.0"))) as archive:
        metadata = json.loads(archive.extractfile("release.json").read())
    assert metadata == {"dbCompatible": False, "minUpdater": "1.2.0",
                        "images": ["ghcr.io/belov38/umiak-quickstart:1.3.0"]}


def test_executing_runtime_version_is_used_in_a_separate_process(tmp_path):
    import shutil
    import subprocess
    import sys
    runtime = tmp_path / "installed-runtime"
    runtime.mkdir()
    shutil.copytree(Path(release.__file__).parent, runtime / "umiak_installer")
    (runtime / "VERSION").write_text("1.2.0")
    target_dir = tmp_path / "target"
    target_dir.mkdir()
    target = bundle(target_dir, {"minUpdater": "1.3.0"})
    script = f"""
from pathlib import Path
from umiak_installer import release, updater
try:
    updater.run_update(None, None, release.Release({target.version!r}, Path({str(target_dir)!r})),
                       ui=None, state_path=None, sleep=None)
except release.ReleaseError as error:
    print(error)
    raise SystemExit(17)
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=runtime, text=True, capture_output=True)
    assert result.returncode == 17, result.stderr
    assert "update to 1.3.0 first" in result.stdout
