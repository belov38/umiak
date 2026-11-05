import io
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from promote_release import repack
from test_release import tarball


def test_promotion_preserves_bundle_sources_and_pins_stable():
    source = "1.2.0-edge.20261105.1"
    data = tarball({"VERSION": (source + "\n").encode(),
                    "compose.yaml": f"image: ghcr.io/belov38/umiak-web:{source}\n".encode(),
                    "node-agent.sha256": b"a" * 64, "release.json": b'{"dbCompatible":false}',
                    "umiak_installer/main.py": b"original source"})
    result = repack(data, source, "1.2.0")
    with tarfile.open(fileobj=io.BytesIO(result), mode="r:gz") as archive:
        assert archive.extractfile("VERSION").read() == b"1.2.0\n"
        assert archive.extractfile("compose.yaml").read().endswith(b":1.2.0\n")
        assert archive.extractfile("umiak_installer/main.py").read() == b"original source"
        assert archive.extractfile("node-agent.sha256").read() == b"a" * 64


def test_promotion_refuses_other_base():
    with pytest.raises(ValueError):
        repack(b"", "1.2.0-edge.20261105.1", "2.0.0")
