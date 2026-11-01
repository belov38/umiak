"""Fixtures of the umiak-sdk tests.

``api``: tests/api_server.ts run with ``node`` (apps/api in process with a
FakeAgent and Postgres, behind a fault proxy) for the whole session.
``client``: the facade under test, once as ``Umiak`` and once as ``AsyncUmiak``
(support.Client).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from support import Client, TestApi

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def api() -> Iterator[TestApi]:
    if os.environ.get("UMIAK_TEST_SKIP_PG") == "1" and not os.environ.get("UMIAK_TEST_DATABASE_URL"):
        pytest.skip("UMIAK_TEST_SKIP_PG=1: no Postgres for apps/api")
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is not in PATH (run through mise: `mise exec -- pnpm test`)")
    proc = subprocess.Popen(
        [node, "tests/api_server.ts"],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
    )
    assert proc.stdout is not None and proc.stdin is not None
    line = proc.stdout.readline()  # the first start may pull the Postgres image
    if not line:
        proc.wait(timeout=30)
        pytest.fail(f"tests/api_server.ts exited with {proc.returncode} before it started")
    info = json.loads(line)
    if "skip" in info:
        proc.wait(timeout=30)
        pytest.skip(info["skip"])
    world = TestApi(info)
    try:
        yield world
    finally:
        world.close()
        proc.stdin.close()  # the server cleans up (database, container) and exits
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


@pytest.fixture(scope="module", params=["sync", "async"])
def client(request: pytest.FixtureRequest, api: TestApi) -> Iterator[Client]:
    c = Client(request.param, api)
    try:
        yield c
    finally:
        c.close()
