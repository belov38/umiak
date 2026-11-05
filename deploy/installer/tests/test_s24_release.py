import json

import pytest

import build_bundle


def test_cutover_pins_installed_bridge_and_incompatible_rollback():
    files = build_bundle.collect(build_bundle.REPO_ROOT, "1.0.0", "ab" * 32)
    metadata = json.loads(files["release.json"])
    assert metadata["minUpdater"] == "0.4.0-edge.20261105.5"
    assert metadata["dbCompatible"] is False


def test_cutover_cannot_be_marked_image_only_compatible():
    with pytest.raises(ValueError, match="S24"):
        build_bundle.collect(build_bundle.REPO_ROOT, "1.0.0", "ab" * 32, db_compatible=True)


def test_cutover_cannot_lower_the_bridge_requirement():
    with pytest.raises(ValueError, match="bridge"):
        build_bundle.collect(build_bundle.REPO_ROOT, "1.0.0", "ab" * 32, min_updater="0.4.0-edge.20261105.4")
