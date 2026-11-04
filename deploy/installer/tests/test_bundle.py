import hashlib
import re
import tarfile

import pytest

import build_bundle
from umiak_installer import release, stack

SHA = "ab" * 32


@pytest.fixture
def built(tmp_path):
    bundle = build_bundle.build("1.2.3", tmp_path / "out", SHA)
    with tarfile.open(bundle) as archive:
        contents = {m.name: archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
    return bundle, contents


def test_bundle_layout(built):
    bundle, contents = built
    assert bundle.name == "umiak-installer-1.2.3.tar.gz"
    assert contents["VERSION"] == b"1.2.3\n"
    assert contents["node-agent.sha256"] == (SHA + "\n").encode()
    for name in stack.STACK_FILES:
        assert name in contents
    assert "umiak_installer/__init__.py" in contents
    assert "umiak_installer/stack.py" in contents
    assert not [n for n in contents if "__pycache__" in n or n.endswith(".pyc") or "tests" in n.split("/")]
    assert all(n == "VERSION" or n == "node-agent.sha256" or n in stack.STACK_FILES or n.startswith("umiak_installer/")
               for n in contents)


def test_compose_is_pinned_and_pull_only(built):
    compose = built[1]["compose.yaml"].decode()
    assert "${UMIAK_VERSION" not in compose
    assert not re.search(r"^\s*build:", compose, re.M)
    images = re.findall(r"image: (ghcr\.io/belov38/umiak-\S+)", compose)
    assert images
    assert all(image.endswith(":1.2.3") for image in images)
    names = {i.split(":")[0].removeprefix("ghcr.io/belov38/umiak-") for i in images}
    assert names == {"quickstart", "api", "worker", "web", "mcp", "secrets-init"}


def test_sha256sums_matches_bundle_and_release_parser(built):
    bundle, _ = built
    sums = (bundle.parent / "SHA256SUMS").read_text()
    assert release.expected_sha(sums, bundle.name) == hashlib.sha256(bundle.read_bytes()).hexdigest()


def test_deterministic(tmp_path):
    a = build_bundle.build("1.2.3", tmp_path / "a", SHA)
    b = build_bundle.build("1.2.3", tmp_path / "b", SHA)
    assert a.read_bytes() == b.read_bytes()


def test_unpacks_with_release_module(built, tmp_path):
    bundle, _ = built
    sums = (bundle.parent / "SHA256SUMS").read_bytes()
    assets = {bundle.name: bundle.read_bytes(), "SHA256SUMS": sums}
    result = release.download("1.2.3", tmp_path / "dest", fetch=lambda url: assets[url.rsplit("/", 1)[1]])
    assert result.node_agent_sha256 == SHA
    assert (result.root / "compose.yaml").is_file()


@pytest.mark.parametrize("version", ["", "../x", "v1"])
def test_rejects_bad_version(tmp_path, version):
    with pytest.raises(release.InstallerError):
        build_bundle.build(version, tmp_path, SHA)


def test_rejects_bad_checksum(tmp_path):
    with pytest.raises(SystemExit):
        build_bundle.build("1.2.3", tmp_path, "nothex")
