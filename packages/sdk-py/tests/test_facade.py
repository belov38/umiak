"""The facades against the real apps/api (tests/api_server.ts: Postgres,
FakeAgent, a fault proxy), the SDK scenario of S7 §16 without the PTY and
directory archives (not in the Python SDK yet): create(wait) -> exec (a 503
on its first POST is retried with the same Idempotency-Key and starts the
command once) -> run with a failed agent attach and a cut client stream ->
idle stream -> start + follow -> files (write/read, a 20 MiB resumable upload,
resumed and restarted downloads) -> ports -> list -> snapshots -> delete.

Every test runs twice: with Sbx and with AsyncSbx (conftest.Client).
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from support import Client, TestApi, until

from sbx_sdk import ExitEvent, OutputEvent, SandboxFailedError, SbxError

MiB = 1024 * 1024


def sha256(b: bytes | str) -> str:
    return hashlib.sha256(b.encode() if isinstance(b, str) else b).hexdigest()


def join_output(events: list[Any]) -> dict[str, Any]:
    """Joins the output of each stream, checking the offsets are contiguous."""
    text = {"stdout": "", "stderr": ""}
    nxt = {"stdout": 0, "stderr": 0}
    for ev in events:
        if isinstance(ev, OutputEvent) and ev.type in text:
            assert ev.offset == nxt[ev.type]
            nxt[ev.type] = ev.next_offset
            text[ev.type] += ev.data
    return {**text, "next": nxt}


def query(path: str) -> dict[str, list[str]]:
    return parse_qs(urlsplit(path).query)


@pytest.fixture(scope="module")
def suite(client: Client) -> str:
    return f"py-{os.getpid()}-{client.kind}"


@pytest.fixture(scope="module")
def state(client: Client) -> dict[str, Any]:
    """Objects that later tests of the same facade use (the sandbox)."""
    return {}


def sandbox(state: dict[str, Any]) -> Any:
    sb = state.get("sb")
    if sb is None:
        pytest.skip("no sandbox: create(wait) failed")
    return sb


def test_create_wait_returns_once_ready(
    client: Client, api: TestApi, suite: str, state: dict[str, Any]
) -> None:
    before = set(api.creating())

    def worker() -> str:
        # The worker's part: the sandbox becomes ready while the SDK long-polls.
        slug = until(
            lambda: next((s for s in api.creating() if s not in before), None),
            what="a creating sandbox",
        )
        time.sleep(0.3)
        api.mark_ready(slug)
        return slug

    marked = client.in_thread(worker)
    n0 = api.request_count()
    sb = client.sbx.sandboxes.create(labels={"suite": suite}, wait=True)
    slug = marked()
    assert sb.slug == slug
    assert sb.state == "ready"
    assert sb.id.startswith("sb_")
    polls = [r for r in api.requests(n0) if r["method"] == "GET" and "waitFor=ready" in r["path"]]
    assert 1 <= len(polls) < 5
    created = [r for r in api.requests(n0) if r["method"] == "POST"]
    assert created[0]["headers"]["idempotency-key"]
    assert created[0]["headers"]["user-agent"].startswith("sbx-sdk-py/")
    state["sb"] = sb


def test_exec_collects_stdout_stderr_exit_code(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    r = sb.exec("echo out; echo err >&2; exit 3", env={"A": "1"})
    assert (r.stdout, r.stderr, r.exit_code) == ("out\n", "err\n", 3)
    assert not r.stdout_truncated and not r.stderr_truncated
    assert (r.stdout_from, r.stderr_from, r.output_truncated) == (0, 0, None)
    assert r.command.status == "exited"
    assert r.command.mode == "stream"
    assert r.command.env_keys == ["A"]


def test_exec_keeps_the_last_4_mib(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    r = sb.exec("head -c 5000000 /dev/zero | tr '\\0' a; echo; echo end")
    assert r.exit_code == 0
    assert r.stdout_truncated
    assert 4 * MiB - 70_000 < len(r.stdout) <= 4 * MiB
    assert r.stdout.endswith("aaa\nend\n")
    assert not r.stderr_truncated
    # The tail starts where the dropped output ends: from + its bytes = the size.
    assert r.stdout_from == 5_000_000 + 1 + 4 - len(r.stdout.encode())
    assert r.stderr_from == 0


def test_exec_after_a_503_is_retried_with_the_same_key_and_starts_once(
    api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    # The api starts the command; its answer is lost behind a proxy 503.
    api.fault("replace", method="POST", pathEndsWith="/commands", status=503)
    n0 = api.request_count()
    r = sb.exec("echo once-$((20+22))")
    assert (r.stdout, r.exit_code) == ("once-42\n", 0)
    posts = [x for x in api.requests(n0) if x["method"] == "POST"]
    assert len(posts) == 2
    key = posts[0]["headers"]["idempotency-key"]
    assert key and posts[1]["headers"]["idempotency-key"] == key
    assert api.start_count(r.command.id) == 1


def test_run_reattaches_after_a_failed_attach_and_a_cut_stream(
    api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    # The api's attach to the agent ends with error{agent_unavailable,
    # retryable} after 20 000 bytes; the SDK must reopen /stream.
    api.fail_next_attach(sb.slug, 20_000, "unavailable")
    # The first reattach (GET /stream) breaks after 30 000 bytes.
    api.fault("cut", method="GET", pathEndsWith="/stream", bytes=30_000)
    line = "x" * 90
    script = (
        f'for i in $(seq 1 2000); do echo "out-$i-{line}"; done; '
        'for i in $(seq 1 300); do echo "err-$i" >&2; done; exit 7'
    )
    expected_out = "".join(f"out-{i}-{line}\n" for i in range(1, 2001))
    expected_err = "".join(f"err-{i}\n" for i in range(1, 301))
    n0 = api.request_count()
    started: list[Any] = []
    events = list(sb.run(script, on_start=started.append))
    out = join_output(events)
    assert sha256(out["stdout"]) == sha256(expected_out)
    assert sha256(out["stderr"]) == sha256(expected_err)
    last = events[-1]
    assert isinstance(last, ExitEvent)
    assert (last.status, last.exit_code) == ("exited", 7)
    assert (last.stdout_offset, last.stderr_offset) == (len(expected_out), len(expected_err))
    assert started and started[0].id.startswith("cmd_")
    assert api.start_count(started[0].id) == 1
    reattaches = [r for r in api.requests(n0) if r["path"].split("?")[0].endswith("/stream")]
    assert len(reattaches) >= 2


def test_multibyte_utf8_survives_attach_failures_and_cuts_inside_characters(
    api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    text = "aé€😀" * 60 + "\n"  # 1 + 2 + 3 + 4 bytes per unit
    size = len(text.encode())
    # One byte per agent event: the api frames whole characters, offsets stay bytes.
    previous = api.agent_chunk_size(1)
    try:
        # The agent attach fails 15 bytes in (inside the 4-byte character), and
        # the first reattach is cut inside its body.
        api.fail_next_attach(sb.slug, 15, "unavailable")
        api.fault("cut", method="GET", pathEndsWith="/stream", bytes=1500)
        n0 = api.request_count()
        events = list(sb.run(["printf", "%s", text]))
        reattaches = [r for r in api.requests(n0) if r["path"].split("?")[0].endswith("/stream")]
        api.fail_next_attach(sb.slug, 7, "unavailable")
        r = sb.exec(["printf", "%s", text])
    finally:
        api.agent_chunk_size(previous)
    out = join_output(events)
    assert out["stdout"] == text
    assert out["next"]["stdout"] == size
    assert isinstance(events[-1], ExitEvent) and events[-1].stdout_offset == size
    assert len(reattaches) >= 2
    for ev in events:
        if isinstance(ev, OutputEvent):
            assert ev.next_offset - ev.offset == len(ev.data.encode())
    assert (r.stdout, r.exit_code) == (text, 0)


def test_a_silent_stream_is_reopened_from_its_offsets(
    client: Client, api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    quick = client.make(stream_idle_timeout=0.4)
    s = quick.sandboxes.get(sb.slug)
    # The first answer delivers a few bytes, then nothing more.
    api.fault("stall", method="POST", pathEndsWith="/commands", bytes=300)
    t0 = time.monotonic()
    events = list(s.run("for i in $(seq 1 50); do echo idle-$i; done"))
    assert join_output(events)["stdout"] == "".join(f"idle-{i}\n" for i in range(1, 51))
    assert time.monotonic() - t0 < 10


def test_command_wait_and_follow_accept_a_timeout(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    c = sb.start("sleep 30")
    t0 = time.monotonic()
    with pytest.raises(SbxError) as e:
        c.wait(timeout=0.5)
    assert e.value.code == "wait_timeout"
    assert time.monotonic() - t0 < 5
    with pytest.raises(SbxError) as e2:
        for _ in c.follow(timeout=0.5):
            pass
    assert e2.value.code == "wait_timeout"
    c.kill(grace_ms=0)
    assert c.wait(timeout=10).status == "killed"


def test_breaking_out_of_run_does_not_kill_the_command(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    started: list[Any] = []
    for ev in sb.run("echo first; sleep 30", on_start=started.append):
        assert isinstance(ev, OutputEvent)
        assert (ev.type, ev.data) == ("stdout", "first\n")
        break
    cmd = started[0]
    time.sleep(0.2)
    assert cmd.refresh().status == "running"
    assert cmd.kill(grace_ms=0).id == cmd.id
    assert cmd.wait().status == "killed"


def test_start_and_follow_from_start_and_end_and_output(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    cmd = sb.start("for i in 1 2 3; do echo n$i; sleep 0.1; done")
    assert cmd.id.startswith("cmd_")
    assert cmd.data.mode == "detached"
    events = list(cmd.follow(start="start"))
    assert join_output(events)["stdout"] == "n1\nn2\nn3\n"
    assert isinstance(events[-1], ExitEvent) and events[-1].exit_code == 0

    tail = list(cmd.follow(start="end"))
    assert len(tail) == 1 and isinstance(tail[0], ExitEvent)

    part = cmd.output("stdout", 3, 3)
    assert part.data == b"n2\n"
    assert (part.offset, part.next_offset, part.end) == (3, 6, 9)

    b64 = list(cmd.follow(encoding="base64"))
    assert isinstance(b64[0], OutputEvent) and b64[0].type == "stdout"
    assert isinstance(b64[0].data, bytes)
    assert b"".join(e.data for e in b64 if isinstance(e, OutputEvent)) == b"n1\nn2\nn3\n"


def test_files_write_read_stat_list_mkdir_move_chmod_remove(state: dict[str, Any]) -> None:
    f = sandbox(state).files
    info = f.write_text("notes/hi.txt", "hi there", mode=0o600)
    assert (info.name, info.type_, info.size_bytes, info.mode) == ("hi.txt", "file", 8, 0o600)
    assert f.read_text("notes/hi.txt") == "hi there"
    blob = os.urandom(70_000)
    f.write_bytes("notes/bin.dat", blob)
    assert sha256(f.read_bytes("notes/bin.dat")) == sha256(blob)
    assert f.stat("notes/bin.dat").size_bytes == 70_000
    f.mkdir("notes/sub/deep", parents=True)
    assert sorted(e.name for e in f.list("notes", limit=1)) == ["bin.dat", "hi.txt", "sub"]
    f.move("notes/hi.txt", "notes/sub/hi.txt")
    assert f.read_text("notes/sub/hi.txt") == "hi there"
    assert f.chmod("notes/sub/hi.txt", mode=0o644).mode == 0o644
    assert f.remove("notes/bin.dat").existed is True
    assert f.remove("notes/bin.dat").existed is False
    with pytest.raises(SbxError) as e:
        f.read_text("notes/bin.dat")
    assert (e.value.status, e.value.code) == (404, "path_not_found")
    assert e.value.request_id


def test_upload_survives_a_lost_chunk_answer_and_download_resumes_with_range(
    api: TestApi, state: dict[str, Any], tmp_path: Path
) -> None:
    sb = sandbox(state)
    data = os.urandom(20 * MiB)
    # The second chunk reaches the agent, its answer is lost.
    api.fault("drop", method="PUT", pathIncludes="/files/uploads/", nth=2)
    n0 = api.request_count()
    progress: list[int] = []
    info = sb.files.upload("big/blob.bin", data, on_progress=progress.append)
    assert info.size_bytes == len(data)
    assert progress[-1] == len(data)
    mine = api.requests(n0)
    puts = [r for r in mine if r["method"] == "PUT" and "/files/uploads/" in r["path"]]
    assert len(puts) == 6  # 5 chunks of 4 MiB + the repeat of chunk 2
    assert any(r["path"].split("?")[0].endswith("/commit") for r in mine)

    # Download: the first answer breaks after 9 MiB; the rest comes with Range.
    api.fault("cut", method="GET", pathEndsWith="/files/content", bytes=9 * MiB)
    n1 = api.request_count()
    dest = tmp_path / "blob.bin"
    got = sb.files.download("big/blob.bin", dest)
    assert got.size_bytes == len(data)
    assert sha256(dest.read_bytes()) == sha256(data)
    ranged = [r for r in api.requests(n1) if "range" in r["headers"]]
    assert ranged[-1]["headers"]["range"] == f"bytes={9 * MiB}-"
    assert ranged[-1]["headers"]["if-range"] == got.etag


def test_upload_without_transport_retries_resumes_from_head(
    api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    data = os.urandom(9 * MiB)
    api.fault("drop", method="PUT", pathIncludes="/files/uploads/", nth=2)
    n0 = api.request_count()
    info = sb.files.upload("big/resumed.bin", data, retry_budget=0)
    assert info.size_bytes == len(data)
    mine = api.requests(n0)
    head = next(
        i for i, r in enumerate(mine) if r["method"] == "HEAD" and "/files/uploads/" in r["path"]
    )
    assert head > 0
    # After HEAD the upload goes on with the third chunk: chunk 2 is not sent again.
    after = [query(r["path"])["offset"][0] for r in mine[head:] if r["method"] == "PUT"]
    assert after == [str(8 * MiB)]
    assert sha256(sb.files.read_bytes("big/resumed.bin")) == sha256(data)


def test_download_to_a_path_keeps_dest_when_it_fails(
    api: TestApi, state: dict[str, Any], tmp_path: Path
) -> None:
    sb = sandbox(state)
    dest = tmp_path / "keep.txt"
    dest.write_text("old content\n")
    with pytest.raises(SbxError) as e:
        sb.files.download("no/such/file.txt", dest)
    assert e.value.code == "path_not_found"
    assert dest.read_text() == "old content\n"
    assert not (tmp_path / "keep.txt.tmp").exists()
    sb.files.write_text("small/new.txt", "new content\n")
    sb.files.download("small/new.txt", dest)
    assert dest.read_text() == "new content\n"
    assert not (tmp_path / "keep.txt.tmp").exists()


def test_download_restarts_when_the_file_changed(
    api: TestApi, state: dict[str, Any], tmp_path: Path
) -> None:
    sb = sandbox(state)
    first = os.urandom(2 * MiB)
    second = os.urandom(3 * MiB)
    sb.files.write_bytes("big/changing.bin", first)
    # While the first answer is cut, the file is rewritten: If-Range no longer matches.
    api.fault(
        "cut",
        method="GET",
        pathEndsWith="/files/content",
        bytes=MiB,
        before={
            "method": "PUT",
            "path": f"/v1/sandboxes/{sb.id}/files/content?path=big%2Fchanging.bin",
            "bodyBase64": base64.b64encode(second).decode(),
        },
    )
    n0 = api.request_count()
    dest = tmp_path / "changing.bin"
    got = sb.files.download("big/changing.bin", dest)
    assert got.size_bytes == len(second)
    assert sha256(dest.read_bytes()) == sha256(second)
    gets = [r for r in api.requests(n0) if r["method"] == "GET" and "changing.bin" in r["path"]]
    assert gets[1]["headers"]["range"] == f"bytes={MiB}-"


def test_ports_host_with_a_token_list_rotate_unhost(state: dict[str, Any]) -> None:
    sb = sandbox(state)
    p = sb.ports.host(8000, access="token")
    assert (p.port, p.access) == (8000, "token")
    assert p.token.startswith("sbxp_")
    assert p.token in p.url_with_token
    assert [h.port for h in sb.ports.list().hosted] == [8000]
    assert sb.ports.rotate_token(8000).token != p.token
    sb.ports.unhost(8000)
    assert sb.ports.list().hosted == []


def test_wait_until_ready_ends_with_wait_timeout(client: Client, suite: str) -> None:
    other = client.sbx.sandboxes.create(labels={"suite": suite})
    assert other.state == "creating"
    t0 = time.monotonic()
    with pytest.raises(SbxError) as e:
        other.wait_until_ready(timeout=1)
    assert e.value.code == "wait_timeout"
    assert not isinstance(e.value, SandboxFailedError)
    assert time.monotonic() - t0 < 5


def test_list_iterates_every_page_and_get_by_slug(
    client: Client, api: TestApi, suite: str, state: dict[str, Any]
) -> None:
    sb = sandbox(state)
    n0 = api.request_count()
    found = [s.slug for s in client.sbx.sandboxes.list(label={"suite": suite}, limit=1)]
    assert len(found) == 2 and sb.slug in found
    pages = [r for r in api.requests(n0) if r["path"].startswith("/v1/sandboxes?")]
    assert len(pages) >= 2
    assert all(query(r["path"])["label"] == [f"suite={suite}"] for r in pages)
    assert client.sbx.sandboxes.get(sb.slug).id == sb.id
    assert client.sbx.me().team.id.startswith("team_")
    assert len(client.sbx.templates()) > 0


def test_snapshot_create_wait_raises_the_operation_error(
    client: Client, api: TestApi, state: dict[str, Any]
) -> None:
    sb = sandbox(state)

    def fail() -> bool:
        return until(
            lambda: api.fail_operation(sb.slug, "save_snapshot", "snapshot_failed", "disk full"),
            what="the save_snapshot operation",
        )

    failed = client.in_thread(lambda: (time.sleep(0.3), fail())[1])
    with pytest.raises(SbxError) as e:
        client.sbx.snapshots.create(
            sandbox=sb.slug, name=f"snap-{os.getpid()}-{client.kind}", wait=True
        )
    failed()
    assert (e.value.code, e.value.message, e.value.retryable) == (
        "snapshot_failed",
        "disk full",
        False,
    )
    assert e.value.details["kind"] == "save_snapshot"
    assert e.value.details["state"] == "failed"


def test_delete_sends_the_confirm_header(api: TestApi, state: dict[str, Any]) -> None:
    sb = sandbox(state)
    n0 = api.request_count()
    op = sb.delete()
    assert op is not None and op.kind == "delete"
    assert sb.state == "deleting"
    dels = [r for r in api.requests(n0) if r["method"] == "DELETE"]
    assert dels[-1]["headers"]["sbx-confirm-delete"] == sb.id
