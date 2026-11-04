import hashlib
import io
import tarfile

import pytest

from umiak_installer import release


def tarball(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def serve(assets: dict[str, bytes]):
    calls = []

    def fetch(url):
        calls.append(url)
        assert url.startswith("https://github.com/belov38/umiak/releases/download/v1.2.3/")
        return assets[url.rsplit("/", 1)[1]]

    return fetch, calls


BUNDLE = tarball({"VERSION": b"1.2.3\n", "compose.yaml": b"name: umiak\n", "node-agent.sha256": b"0" * 64 + b"\n",
                  "umiak_installer/__init__.py": b""})


def sums(data: bytes, name="umiak-installer-1.2.3.tar.gz") -> bytes:
    return f"{hashlib.sha256(data).hexdigest()}  {name}\n".encode()


def test_download_verifies_and_unpacks(tmp_path):
    fetch, calls = serve({"umiak-installer-1.2.3.tar.gz": BUNDLE, "SHA256SUMS": sums(BUNDLE)})
    result = release.download("1.2.3", tmp_path, fetch=fetch)
    assert result.version == "1.2.3"
    assert result.root == tmp_path / "1.2.3"
    assert (result.root / "compose.yaml").read_text() == "name: umiak\n"
    assert result.node_agent_sha256 == "0" * 64
    assert len(calls) == 2


def test_sha_mismatch_aborts_without_unpacking(tmp_path):
    fetch, _ = serve({"umiak-installer-1.2.3.tar.gz": BUNDLE, "SHA256SUMS": sums(b"something else")})
    with pytest.raises(release.ReleaseError, match="Checksum"):
        release.download("1.2.3", tmp_path, fetch=fetch)
    assert not (tmp_path / "1.2.3").exists()


def test_missing_sums_entry_aborts(tmp_path):
    fetch, _ = serve({"umiak-installer-1.2.3.tar.gz": BUNDLE, "SHA256SUMS": sums(BUNDLE, "other.tar.gz")})
    with pytest.raises(release.ReleaseError):
        release.download("1.2.3", tmp_path, fetch=fetch)


def test_rejects_path_traversal_in_bundle(tmp_path):
    evil = tarball({"VERSION": b"1.2.3\n", "../escape": b"x"})
    fetch, _ = serve({"umiak-installer-1.2.3.tar.gz": evil, "SHA256SUMS": sums(evil)})
    with pytest.raises(release.ReleaseError):
        release.download("1.2.3", tmp_path / "dir", fetch=fetch)
    assert not (tmp_path / "escape").exists()


def test_bundle_version_must_match(tmp_path):
    other = tarball({"VERSION": b"9.9.9\n"})
    fetch, _ = serve({"umiak-installer-1.2.3.tar.gz": other, "SHA256SUMS": sums(other)})
    with pytest.raises(release.ReleaseError, match="version"):
        release.download("1.2.3", tmp_path, fetch=fetch)


@pytest.mark.parametrize("bad", ["", "1.2.3; rm", "../1", "v1.2.3", "1 2"])
def test_rejects_invalid_versions(bad):
    with pytest.raises(release.ReleaseError):
        release.valid_version(bad)


def test_latest_version_from_release_redirect():
    assert release.latest_version(resolve=lambda url: "https://github.com/belov38/umiak/releases/tag/v1.4.0") == "1.4.0"
    with pytest.raises(release.ReleaseError):
        release.latest_version(resolve=lambda url: "https://github.com/belov38/umiak/releases")


def test_current_reads_bundle_version(tmp_path):
    (tmp_path / "VERSION").write_text("1.2.3\n")
    assert release.current(tmp_path) == release.Release("1.2.3", tmp_path)


def test_node_agent_sha_is_required(tmp_path):
    (tmp_path / "VERSION").write_text("1.2.3\n")
    with pytest.raises(release.ReleaseError):
        _ = release.current(tmp_path).node_agent_sha256
