from pathlib import Path

import pytest

from umiak_installer import prepare_host, tailnet
from umiak_installer.pve import InstallerError, Runner


def test_remove_node_artifacts_drops_cache_and_only_umiak_media(tmp_path):
    runner = Runner(root=tmp_path)
    media = tmp_path / "mnt/media"
    (media / "import").mkdir(parents=True)
    (media / "template/iso").mkdir(parents=True)
    for name in ("umiak-ubuntu-26.04-minimal-20261024.qcow2", "umiak-seed-x.raw", ".umiak-layer-job-1",
                 "ubuntu-26.04-server-cloudimg-amd64.qcow2", "hasp.qcow2"):
        (media / "import" / name).write_text("x")
    for name in ("umiak-virtio-win-1.iso", "debian.iso"):
        (media / "template/iso" / name).write_text("x")
    (media / "import/umiak-dir").mkdir()
    config = runner.path(prepare_host.NODE_CONFIG)
    config.parent.mkdir(parents=True)
    config.write_text('importDir = "/mnt/media/import"\nisoDir = "/mnt/media/template/iso"\n')
    binary = runner.path(prepare_host.NODE_BINARY)
    binary.parent.mkdir(parents=True)
    binary.write_text("bin")
    cache = runner.path(prepare_host.NODE_STATE_DIR) / "layer-cache"
    cache.mkdir(parents=True)
    (cache / "blob").write_text("x")

    prepare_host.remove_node_artifacts(runner)

    assert sorted(p.name for p in (media / "import").iterdir()) == [
        "hasp.qcow2", "ubuntu-26.04-server-cloudimg-amd64.qcow2", "umiak-dir"]
    assert [p.name for p in (media / "template/iso").iterdir()] == ["debian.iso"]
    assert not runner.path(prepare_host.NODE_STATE_DIR).exists()
    assert not binary.exists() and not config.exists()


def test_remove_node_artifacts_without_config_uses_default_media_dirs(tmp_path):
    runner = Runner(root=tmp_path)
    imports = runner.path("/var/lib/vz/import")
    imports.mkdir(parents=True)
    (imports / "umiak-seed-x.raw").write_text("x")
    prepare_host.remove_node_artifacts(runner)
    assert list(imports.iterdir()) == []


def test_rename_hint_only_when_tailscale_picked_another_name():
    assert tailnet.rename_hint("umiak", "umiak.tail1.ts.net") is None
    hint = tailnet.rename_hint("umiak", "umiak-3.tail1.ts.net")
    assert hint and "'umiak-3'" in hint and tailnet.MACHINES_URL in hint


def test_expired_login_says_the_link_expired_and_how_to_resume():
    runner = Runner(root=Path("/"))
    runner.run = lambda argv, input=None: (  # type: ignore[method-assign]
        '{"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/x"}'
        if argv[-2:] == ["status", "--json"] else "")
    ticks = iter([0, 0, 2000])
    with pytest.raises(InstallerError, match=r"expired\. Rerun the same install command.*new link"):
        tailnet.up(runner, 590, "umiak", out=lambda *_: None, sleep=lambda _s: None, timeout=1800,
                   clock=lambda: next(ticks))
