"""Transport, retry policy (S7 §15.4), credential chain (S7 §7.6), stream
reattach and open enums, without an api: httpx.MockTransport answers, and a
fake clock replaces the waits (the sync facade; the async one at the end).
"""

from __future__ import annotations

import json
import os
import stat
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

import umiak_sdk._async.client as async_client
import umiak_sdk._sync._io as sync_io
import umiak_sdk._sync.client as sync_client
import umiak_sdk._sync.commands as sync_commands
import umiak_sdk._sync.sandbox as sync_sandbox
from umiak_sdk import AsyncUmiak, ExitEvent, Offsets, OutputEvent, Umiak, UmiakError, models
from umiak_sdk._async import _io as async_io
from umiak_sdk._retry import backoff

API = "https://api.test"
SANDBOX: dict[str, Any] = {
    "id": "sb_01m65wges2f17tw54m3bgfsjhp",
    "slug": "coral-orchid-thunder",
    "name": None,
    "teamId": "team_7wgk8j20w9968skse23n3dcc7g",
    "createdBy": None,
    "createdByKey": "key_01m65wge2afj9am2610rckf1yj",
    "template": "linux",
    "templateVersion": "v4",
    "size": "2gb",
    "vcpu": 2,
    "memoryMb": 2048,
    "state": "ready",
    "health": "ok",
    "healthReason": None,
    "degradedSince": None,
    "activity": "unknown",
    "lastActivityAt": None,
    "stopReason": None,
    "error": None,
    "origin": {"kind": "template"},
    "labels": {},
    "ttlSeconds": None,
    "deadlineAt": None,
    "idleTimeoutSeconds": 900,
    "activeOperation": None,
    "endpoints": {
        "portUrlTemplate": "https://coral-orchid-thunder-{port}.umiak.test",
        "ssh": "ssh coral-orchid-thunder@ssh.umiak.test",
    },
    "environment": None,
    "excludeOwnerSecrets": False,
    "blocked": False,
    "blockReason": None,
    "createdAt": "2026-10-30T07:48:37.791Z",
    "readyAt": None,
    "stoppedAt": None,
    "deletedAt": None,
    "updatedAt": "2026-10-30T07:48:37.791Z",
}
OPERATION: dict[str, Any] = {
    "id": "op_01m65wges2e2yb37hpwncectyd",
    "sandboxId": SANDBOX["id"],
    "kind": "create",
    "state": "pending",
    "step": None,
    "error": None,
    "forceStop": None,
    "createdAt": "2026-10-30T07:48:37.791Z",
    "startedAt": None,
    "finishedAt": None,
}
SB_PATH = f"/v1/sandboxes/{SANDBOX['id']}"
CMD = "cmd_01m65wgf0000000000000000"


def envelope(
    status: int, code: str, retryable: bool, headers: dict[str, str] | None = None
) -> httpx.Response:
    body = {
        "error": {
            "code": code,
            "message": f"{code} message",
            "retryable": retryable,
            "details": {},
            "requestId": "req_1",
        }
    }
    return httpx.Response(status, json=body, headers=headers)


def proxy_page(status: int = 503) -> httpx.Response:
    return httpx.Response(status, text="<html>503 Service Unavailable</html>")


def ndjson(*frames: dict[str, Any]) -> bytes:
    return b"".join(json.dumps(f).encode() + b"\n" for f in frames)


class BrokenBody(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A body that sends ``chunks`` and then breaks."""

    def __init__(self, *chunks: bytes) -> None:
        self._chunks = chunks

    def __iter__(self) -> Iterator[bytes]:
        yield from self._chunks
        raise httpx.ReadError("connection reset (test)")

    async def __aiter__(self) -> Any:
        for c in self._chunks:
            yield c
        raise httpx.ReadError("connection reset (test)")


class Script:
    """Answers requests from a list (or a function); records them."""

    def __init__(self, *answers: httpx.Response | Exception | Callable[[httpx.Request], Any]):
        self.answers = list(answers)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        # A copy: a retry sends the same Request object with new headers.
        self.requests.append(
            httpx.Request(
                request.method, request.url, headers=request.headers.copy(), content=request.read()
            )
        )
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if callable(a) and not isinstance(a, httpx.Response):
            a = a(request)
        if isinstance(a, Exception):
            raise a
        return a

    def paths(self) -> list[str]:
        return [f"{r.method} {r.url.raw_path.decode()}" for r in self.requests]


class FakeClock:
    """time.monotonic and sleep of the facade modules: sleeps only advance the clock."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.waits: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def time(self) -> float:
        return time.time()

    def sleep(self, s: float) -> None:
        self.waits.append(s)
        self.now += s


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    c = FakeClock()
    for mod in (sync_client, sync_commands, sync_sandbox):
        monkeypatch.setattr(mod, "time", c)
        monkeypatch.setattr(mod, "sleep", c.sleep, raising=False)
    return c


def umiak(script: Script, *, random: float = 0.0, **kw: Any) -> Umiak:
    opts: dict[str, Any] = {"base_url": API, "api_key": "umiak_test", "env": {}}
    opts.update(kw)
    return Umiak(**opts, transport=httpx.MockTransport(script), random=lambda: random)


# --- retry policy ---


def test_keyed_post_is_retried_on_a_proxy_503_with_the_same_key(clock: FakeClock) -> None:
    s = Script(
        proxy_page(),
        proxy_page(),
        httpx.Response(202, json={"sandbox": SANDBOX, "operation": OPERATION}),
    )
    sb = umiak(s, team="team_x").sandboxes.create(template="linux", ttl_seconds=60)
    assert sb.id == SANDBOX["id"]
    keys = {r.headers["Idempotency-Key"] for r in s.requests}
    assert len(s.requests) == 3 and len(keys) == 1
    r = s.requests[0]
    assert r.headers["Authorization"] == "Bearer umiak_test"
    assert r.headers["Umiak-Team"] == "team_x"
    assert r.headers["User-Agent"].startswith("umiak-sdk-py/")
    assert json.loads(r.content) == {"template": "linux", "ttlSeconds": 60}
    assert str(r.url) == f"{API}/v1/sandboxes"


def test_keyed_post_is_retried_after_a_network_error(clock: FakeClock) -> None:
    s = Script(
        httpx.ConnectError("refused"),
        httpx.Response(202, json={"sandbox": SANDBOX, "operation": OPERATION}),
    )
    umiak(s).sandboxes.create(idempotency_key="my-key")
    assert [r.headers["Idempotency-Key"] for r in s.requests] == ["my-key", "my-key"]


def test_unkeyed_post_with_retryable_false_is_not_retried(clock: FakeClock) -> None:
    s = Script(httpx.Response(200, json=SANDBOX), envelope(503, "agent_unavailable", False))
    sb = umiak(s).sandboxes.get("x")
    with pytest.raises(UmiakError) as e:
        sb.stop()
    assert (e.value.status, e.value.code, e.value.request_id) == (503, "agent_unavailable", "req_1")
    assert s.paths() == ["GET /v1/sandboxes/x", f"POST {SB_PATH}/stop"]
    assert "Idempotency-Key" not in s.requests[1].headers


def test_unkeyed_post_network_error_is_not_retried_but_get_is(clock: FakeClock) -> None:
    s = Script(httpx.ConnectError("refused"))
    client = umiak(s)
    with pytest.raises(UmiakError) as e:
        client.raw.get_httpx_client().post(f"{SB_PATH}/stop")
    assert (e.value.code, e.value.retryable) == ("network_error", False)
    assert len(s.requests) == 1

    s2 = Script(
        httpx.ConnectError("refused"),
        httpx.ReadTimeout("slow"),
        httpx.Response(200, json=SANDBOX),
    )
    assert umiak(s2).sandboxes.get("x").slug == SANDBOX["slug"]
    assert len(s2.requests) == 3


def test_api_error_with_retryable_true_is_retried_for_any_method(clock: FakeClock) -> None:
    action = {"sandbox": SANDBOX, "operation": {**OPERATION, "kind": "stop"}}
    s = Script(
        httpx.Response(200, json=SANDBOX),
        envelope(409, "operation_in_progress", True),
        httpx.Response(202, json=action),
    )
    op = umiak(s).sandboxes.get("x").stop()
    assert op.kind == "stop"
    assert s.paths()[1:] == [f"POST {SB_PATH}/stop"] * 2


def test_retry_after_wins_over_a_shorter_backoff(clock: FakeClock) -> None:
    s = Script(
        envelope(429, "rate_limited", True, {"Retry-After": "2"}),
        httpx.Response(200, json=SANDBOX),
    )
    umiak(s, random=1.0).sandboxes.get("x")
    assert clock.waits == [2.0]


def test_retry_after_zero_still_backs_off(clock: FakeClock) -> None:
    s = Script(
        envelope(503, "agent_unavailable", True, {"Retry-After": "0"}),
        envelope(503, "agent_unavailable", True, {"Retry-After": "0"}),
        httpx.Response(200, json=SANDBOX),
    )
    umiak(s, random=1.0).sandboxes.get("x")
    assert clock.waits == [0.5, 1.0]


def test_backoff_doubles_up_to_8_seconds_with_full_jitter() -> None:
    assert [backoff(n, lambda: 1.0) for n in range(6)] == [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]
    assert backoff(3, lambda: 0.25) == 1.0


def test_the_budget_ends_the_retries_with_the_last_error(clock: FakeClock) -> None:
    s = Script(proxy_page(502))
    with pytest.raises(UmiakError) as e:
        umiak(s, random=1.0).sandboxes.get("x", retry_budget=2)
    assert (e.value.status, e.value.code) == (502, "unexpected_response")
    # Waits 0.5 + 1.0 fit in 2 s; the next (2.0) would not.
    assert clock.waits == [0.5, 1.0]
    assert len(s.requests) == 3

    s0 = Script(proxy_page(503))
    with pytest.raises(UmiakError):
        umiak(s0, retry_budget=0).sandboxes.get("x")
    assert len(s0.requests) == 1


def test_a_proxy_error_page_is_not_retried_for_an_unkeyed_post(clock: FakeClock) -> None:
    s = Script(proxy_page(503))
    with pytest.raises(UmiakError) as e:
        umiak(s).raw.get_httpx_client().post(f"{SB_PATH}/stop")
    assert e.value.code == "unexpected_response"
    assert len(s.requests) == 1


def test_the_raw_generated_client_uses_the_same_transport(clock: FakeClock) -> None:
    from umiak_sdk._gen.api.sandboxes import sandboxes_get

    s = Script(proxy_page(), httpx.Response(200, json=SANDBOX))
    data = sandboxes_get.sync("x", client=umiak(s).raw)
    assert isinstance(data, models.Sandbox) and data.id == SANDBOX["id"]
    assert len(s.requests) == 2
    assert s.requests[0].headers["Authorization"] == "Bearer umiak_test"


# --- token refresh and the credential chain ---


def test_token_expired_gets_one_new_token_and_one_repeat(clock: FakeClock) -> None:
    calls: list[bool] = []

    def provider(force: bool) -> str:
        calls.append(force)
        return "t2" if force else "t1"

    s = Script(envelope(401, "token_expired", False), httpx.Response(200, json=SANDBOX))
    umiak(s, api_key=None, token_provider=provider).sandboxes.get("x")
    assert [r.headers["Authorization"] for r in s.requests] == ["Bearer t1", "Bearer t2"]
    assert calls == [False, True]

    s2 = Script(envelope(401, "token_expired", False))
    with pytest.raises(UmiakError) as e:
        umiak(s2, api_key=None, token_provider=provider).sandboxes.get("x")
    assert e.value.code == "token_expired"
    assert len(s2.requests) == 2


def test_a_failing_token_provider_sends_nothing() -> None:
    def provider(force: bool) -> str:
        raise RuntimeError("vault down")

    s = Script(httpx.Response(200, json=SANDBOX))
    with pytest.raises(UmiakError) as e:
        umiak(s, api_key=None, token_provider=provider).sandboxes.get("x")
    assert (e.value.code, e.value.retryable) == ("token_provider_failed", False)
    assert s.requests == []


def test_explicit_credentials_beat_the_environment() -> None:
    s = Script(httpx.Response(200, json=SANDBOX))
    env = {
        "UMIAK_API_KEY": "umiak_env",
        "UMIAK_ACCESS_TOKEN": "jwt",
        "UMIAK_API_URL": "https://env.test",
    }
    umiak(s, env=env).sandboxes.get("x")
    assert s.requests[-1].headers["Authorization"] == "Bearer umiak_test"
    assert str(s.requests[-1].url).startswith(API)
    Umiak(env=env, transport=httpx.MockTransport(s)).sandboxes.get("x")
    assert s.requests[-1].headers["Authorization"] == "Bearer umiak_env"
    assert str(s.requests[-1].url).startswith("https://env.test/v1/")
    Umiak(env={**env, "UMIAK_API_KEY": ""}, transport=httpx.MockTransport(s)).sandboxes.get("x")
    assert s.requests[-1].headers["Authorization"] == "Bearer jwt"


def test_a_key_without_an_api_url_is_no_api_url() -> None:
    with pytest.raises(UmiakError) as e:
        Umiak(api_key="umiak_x", env={}, transport=httpx.MockTransport(Script())).me()
    assert e.value.code == "no_api_url"


class FakeUmiak:
    """An `umiak` executable in a temp dir that prints a profile token."""

    def __init__(self, root: Path) -> None:
        self.dir = root
        self.path = root / "umiak"
        self.path.write_text(
            "#!/bin/sh\n"
            'd=$(dirname "$0")\n'
            'n=$(cat "$d/count" 2>/dev/null || echo 0); echo $((n+1)) > "$d/count"\n'
            'if [ -f "$d/sleep" ]; then sleep "$(cat "$d/sleep")"; fi\n'
            'if [ -f "$d/exit" ]; then echo "not logged in" >&2; exit "$(cat "$d/exit")"; fi\n'
            'cat "$d/out"\n'
        )
        self.path.chmod(self.path.stat().st_mode | stat.S_IEXEC)

    def profile(self, token: str, api_url: str = API, expires_in: float | None = 3600) -> None:
        expires = (
            None
            if expires_in is None
            else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + expires_in))
        )
        (self.dir / "out").write_text(
            json.dumps(
                {
                    "kind": "owner",
                    "token": token,
                    "expiresAt": expires,
                    "apiUrl": api_url,
                    "team": "team_profile",
                }
            )
        )

    @property
    def runs(self) -> int:
        f = self.dir / "count"
        return int(f.read_text()) if f.exists() else 0

    def env(self) -> dict[str, str]:
        return {"PATH": f"{self.dir}:/usr/bin:/bin"}


@pytest.fixture
def fake_umiak(tmp_path: Path) -> FakeUmiak:
    return FakeUmiak(tmp_path)


def test_the_umiak_profile_gives_url_team_and_a_cached_token(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-1")
    s = Script(httpx.Response(200, json=SANDBOX))
    client = Umiak(env=fake_umiak.env(), transport=httpx.MockTransport(s))
    client.sandboxes.get("x")
    client.sandboxes.get("x")
    assert fake_umiak.runs == 1
    r = s.requests[-1]
    assert (r.headers["Authorization"], r.headers["Umiak-Team"]) == ("Bearer jwt-1", "team_profile")
    assert str(r.url).startswith(f"{API}/v1/")


def test_a_profile_token_is_refreshed_within_60_s_of_its_expiry(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-short", expires_in=30)
    s = Script(httpx.Response(200, json=SANDBOX))
    client = Umiak(env=fake_umiak.env(), transport=httpx.MockTransport(s))
    client.sandboxes.get("x")
    client.sandboxes.get("x")
    assert fake_umiak.runs == 3  # resolve, then a run before each request


def test_a_profile_of_another_api_is_never_used(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-1", api_url="https://other.test")
    s = Script(httpx.Response(200, json=SANDBOX))
    with pytest.raises(UmiakError) as e:
        Umiak(base_url=API, env=fake_umiak.env(), transport=httpx.MockTransport(s)).me()
    assert e.value.code == "no_credentials"
    assert "other.test" in e.value.message
    assert s.requests == []


def test_token_expired_runs_umiak_again_and_checks_its_api(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-1")
    first = {"done": False}

    def answer(request: httpx.Request) -> httpx.Response:
        if not first["done"]:
            first["done"] = True
            fake_umiak.profile("jwt-2")
            return envelope(401, "token_expired", False)
        return httpx.Response(200, json=SANDBOX)

    s = Script(answer)
    client = Umiak(env=fake_umiak.env(), transport=httpx.MockTransport(s))
    client.sandboxes.get("x")
    assert [r.headers["Authorization"] for r in s.requests] == ["Bearer jwt-1", "Bearer jwt-2"]

    # The profile now points elsewhere: the new token is not sent.
    fake_umiak.profile("jwt-3", api_url="https://other.test")
    s.answers = [envelope(401, "token_expired", False)]
    with pytest.raises(UmiakError) as e:
        client.sandboxes.get("x")
    assert e.value.code == "no_credentials"
    assert s.requests[-1].headers["Authorization"] == "Bearer jwt-2"


def test_umiak_exit_4_or_missing_is_no_credentials_other_failures_are_auth_command_failed(
    fake_umiak: FakeUmiak,
) -> None:
    fake_umiak.profile("jwt-1")
    (fake_umiak.dir / "exit").write_text("4")
    transport = httpx.MockTransport(Script(httpx.Response(200, json=SANDBOX)))
    with pytest.raises(UmiakError) as e:
        Umiak(env=fake_umiak.env(), transport=transport).me()
    assert e.value.code == "no_credentials" and "not logged in" in e.value.message
    (fake_umiak.dir / "exit").write_text("2")
    with pytest.raises(UmiakError) as e:
        Umiak(env=fake_umiak.env(), transport=transport).me()
    assert e.value.code == "auth_command_failed"
    with pytest.raises(UmiakError) as e:
        Umiak(env={"PATH": "/nonexistent"}, transport=transport).me()
    assert e.value.code == "no_credentials" and "not in PATH" in e.value.message
    (fake_umiak.dir / "exit").unlink()
    (fake_umiak.dir / "out").write_text("not json")
    with pytest.raises(UmiakError) as e:
        Umiak(env=fake_umiak.env(), transport=transport).me()
    assert e.value.code == "auth_command_failed"


def test_a_hanging_umiak_is_killed_at_the_timeout(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-1")
    (fake_umiak.dir / "sleep").write_text("30")
    t0 = time.monotonic()
    with pytest.raises(UmiakError) as e:
        sync_io.run_auth_command([str(fake_umiak.path)], fake_umiak.env(), timeout=0.3)
    assert e.value.code == "auth_command_failed" and "timed out" in e.value.message
    # Killed, not waited for (30 s); room for a loaded machine.
    assert time.monotonic() - t0 < 15


async def test_a_hanging_umiak_is_killed_at_the_timeout_async(fake_umiak: FakeUmiak) -> None:
    fake_umiak.profile("jwt-1")
    (fake_umiak.dir / "sleep").write_text("30")
    t0 = time.monotonic()
    with pytest.raises(UmiakError) as e:
        await async_io.run_auth_command([str(fake_umiak.path)], fake_umiak.env(), timeout=0.3)
    assert e.value.code == "auth_command_failed" and "timed out" in e.value.message
    # Killed, not waited for (30 s); room for a loaded machine.
    assert time.monotonic() - t0 < 15


# --- open enums ---


def test_unknown_enum_values_parse() -> None:
    data = {**SANDBOX, "state": "hibernating", "health": "flaky", "origin": {"kind": "import"}}
    s = Script(httpx.Response(200, json=data))
    sb = umiak(s).sandboxes.get("x")
    assert sb.state == "hibernating"
    assert sb.data.health == "flaky" and sb.data.health.value == "flaky"
    assert sb.data.to_dict()["state"] == "hibernating"
    assert models.SandboxState("ready") is models.SandboxState.READY


# --- command streams ---


def stream_umiak(script: Script, **kw: Any) -> Any:
    """A sandbox handle over the scripted transport (no request is sent for it)."""
    client = umiak(script, **kw)
    from umiak_sdk import Sandbox

    return Sandbox(client._core, models.Sandbox.from_dict(SANDBOX))


def test_20_attempts_without_new_bytes_end_with_the_last_error(clock: FakeClock) -> None:
    s = Script(envelope(503, "agent_unavailable", True))
    cmd = stream_umiak(s).command(CMD)
    with pytest.raises(UmiakError) as e:
        list(cmd.follow(start=Offsets(stdout=2, stderr=0)))
    assert e.value.code == "agent_unavailable"
    assert len(s.requests) == 20
    first = s.requests[0].url.params
    assert (first["stdoutOffset"], first["stderrOffset"], first["follow"]) == ("2", "0", "true")


def test_progress_resets_the_failure_count(clock: FakeClock) -> None:
    n = {"i": 0}

    def answer(request: httpx.Request) -> httpx.Response:
        i = n["i"]
        n["i"] += 1
        assert request.url.params["stdoutOffset"] == str(i)
        if i == 40:
            return httpx.Response(
                200,
                content=ndjson(
                    {
                        "type": "exit",
                        "status": "exited",
                        "exitCode": 0,
                        "stdoutOffset": 40,
                        "stderrOffset": 0,
                    }
                ),
            )
        frame = {"type": "stdout", "data": "x", "offset": i, "nextOffset": i + 1}
        return httpx.Response(200, stream=BrokenBody(ndjson(frame)))

    s = Script(answer)
    events = list(stream_umiak(s).command(CMD).follow())
    assert "".join(e.data for e in events if isinstance(e, OutputEvent)) == "x" * 40
    assert isinstance(events[-1], ExitEvent)
    assert len(s.requests) == 41


def test_a_reconnect_frame_is_followed_at_once_from_its_offsets(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(
            200,
            content=ndjson(
                {"type": "attached", "stdoutOffset": 0, "stderrOffset": 0},
                {"type": "heartbeat"},
                {"type": "stdout", "data": "ab", "offset": 0, "nextOffset": 2},
                {"type": "something-new", "x": 1},
                {
                    "type": "reconnect",
                    "reason": "server_shutdown",
                    "stdoutOffset": 2,
                    "stderrOffset": 0,
                },
            ),
        ),
        httpx.Response(
            200,
            content=ndjson(
                {"type": "stdout", "data": "cd", "offset": 2, "nextOffset": 4},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 4,
                    "stderrOffset": 0,
                },
            ),
        ),
    )
    events = list(stream_umiak(s).command(CMD).follow())
    assert [e.data for e in events if isinstance(e, OutputEvent)] == ["ab", "cd"]
    assert clock.waits == []
    assert s.requests[1].url.params["stdoutOffset"] == "2"


def test_a_non_retryable_error_frame_raises_its_code(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(
            200,
            content=ndjson(
                {
                    "type": "error",
                    "code": "unauthorized",
                    "message": "key revoked",
                    "retryable": False,
                    "requestId": "req_9",
                }
            ),
        )
    )
    with pytest.raises(UmiakError) as e:
        list(stream_umiak(s).command(CMD).follow())
    assert (e.value.status, e.value.code, e.value.request_id) == (0, "unauthorized", "req_9")
    assert len(s.requests) == 1


def test_the_start_phase_is_bounded_by_the_retry_budget(clock: FakeClock) -> None:
    s = Script(envelope(503, "agent_unavailable", True))
    t0 = clock.now
    with pytest.raises(UmiakError) as e:
        list(stream_umiak(s, random=1.0).run("ls", retry_budget=1))
    assert e.value.code == "agent_unavailable"
    assert clock.now - t0 <= 1.0
    assert {p.split("?")[0] for p in s.paths()} == {f"POST {SB_PATH}/commands"}
    assert len({r.headers["Idempotency-Key"] for r in s.requests}) == 1


def test_run_posts_once_and_reattaches_by_offset_after_a_break(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(
            200,
            headers={"Umiak-Command-Id": CMD},
            stream=BrokenBody(
                ndjson(
                    {"type": "started", "commandId": CMD},
                    {"type": "stdout", "data": "hé", "offset": 0, "nextOffset": 3},
                )
            ),
        ),
        httpx.Response(
            200,
            content=ndjson(
                {"type": "attached", "stdoutOffset": 3, "stderrOffset": 0},
                {"type": "stderr", "data": "e", "offset": 0, "nextOffset": 1},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 5,
                    "stdoutOffset": 3,
                    "stderrOffset": 1,
                },
            ),
        ),
    )
    started: list[Any] = []
    events = list(stream_umiak(s).run(["echo", "hé"], on_start=started.append))
    assert [p.split("?")[0] for p in s.paths()] == [
        f"POST {SB_PATH}/commands",
        f"GET {SB_PATH}/commands/{CMD}/stream",
    ]
    assert json.loads(s.requests[0].content) == {
        "argv": ["echo", "hé"],
        "mode": "stream",
        "encoding": "utf8",
    }
    assert s.requests[1].url.params["stdoutOffset"] == "3"
    assert started[0].id == CMD
    assert isinstance(events[-1], ExitEvent) and events[-1].exit_code == 5


def test_an_overlapping_utf8_frame_reattaches_from_the_tracked_offset(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(
            200,
            content=ndjson(
                {"type": "stdout", "data": "ab", "offset": 0, "nextOffset": 2},
                {"type": "stdout", "data": "bc", "offset": 1, "nextOffset": 3},
            ),
        ),
        httpx.Response(
            200,
            content=ndjson(
                {"type": "stdout", "data": "cd", "offset": 2, "nextOffset": 4},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 4,
                    "stderrOffset": 0,
                },
            ),
        ),
    )
    events = list(stream_umiak(s).command(CMD).follow())
    assert "".join(e.data for e in events if isinstance(e, OutputEvent)) == "abcd"
    assert len(s.requests) == 2


def test_an_overlapping_base64_frame_is_cut_at_the_tracked_offset(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(
            200,
            content=ndjson(
                {"type": "stdout", "data": "YWJj", "offset": 0, "nextOffset": 3},
                {"type": "stdout", "data": "Y2Rl", "offset": 2, "nextOffset": 5},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 5,
                    "stderrOffset": 0,
                },
            ),
        )
    )
    events = list(stream_umiak(s).command(CMD).follow(encoding="base64"))
    out = [(e.offset, e.data) for e in events if isinstance(e, OutputEvent)]
    assert out == [(0, b"abc"), (3, b"de")]


def test_follow_from_the_end_asks_for_tail_bytes_until_attached(clock: FakeClock) -> None:
    s = Script(
        httpx.Response(200, content=ndjson({"type": "heartbeat"})),
        httpx.Response(
            200,
            content=ndjson(
                {"type": "attached", "stdoutOffset": 7, "stderrOffset": 1},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 7,
                    "stderrOffset": 1,
                },
            ),
        ),
    )
    events = list(stream_umiak(s).command(CMD).follow(start="end"))
    assert len(events) == 1 and isinstance(events[0], ExitEvent)
    for r in s.requests:
        assert r.url.params["tailBytes"] == "0"
        assert "stdoutOffset" not in r.url.params


def test_wait_until_ready_ends_within_its_timeout_against_a_failing_api(clock: FakeClock) -> None:
    s = Script(httpx.Response(200, json={**SANDBOX, "state": "creating"}), proxy_page(503))
    sb = umiak(s, random=1.0).sandboxes.get("x")
    t0 = clock.now
    with pytest.raises(UmiakError) as e:
        sb.wait_until_ready(timeout=1)
    # The last transport error of the poll whose budget is the time left.
    assert (e.value.status, e.value.code) == (503, "unexpected_response")
    assert clock.now - t0 <= 1.0


# --- the asyncio facade ---


async def test_async_keyed_post_is_retried_with_the_same_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waits: list[float] = []

    async def no_sleep(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(async_client, "sleep", no_sleep)
    s = Script(proxy_page(), httpx.Response(202, json={"sandbox": SANDBOX, "operation": OPERATION}))
    calls: list[bool] = []

    async def provider(force: bool) -> str:
        calls.append(force)
        return "jwt-a"

    async with AsyncUmiak(
        base_url=API,
        token_provider=provider,
        env={},
        transport=httpx.MockTransport(s),
        random=lambda: 1.0,
    ) as client:
        sb = await client.sandboxes.create({"template": "linux"})
    assert sb.id == SANDBOX["id"]
    assert len({r.headers["Idempotency-Key"] for r in s.requests}) == 1
    assert [r.headers["Authorization"] for r in s.requests] == ["Bearer jwt-a"] * 2
    assert waits == [0.5]
    assert calls == [False]  # once per call; retries repeat the same request


async def test_async_run_reattaches_after_a_break(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Script(
        httpx.Response(
            200,
            headers={"Umiak-Command-Id": CMD},
            stream=BrokenBody(
                ndjson({"type": "stdout", "data": "a", "offset": 0, "nextOffset": 1})
            ),
        ),
        httpx.Response(
            200,
            content=ndjson(
                {"type": "stdout", "data": "b", "offset": 1, "nextOffset": 2},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 2,
                    "stderrOffset": 0,
                },
            ),
        ),
    )
    async with AsyncUmiak(
        base_url=API, api_key="k", env={}, transport=httpx.MockTransport(s), random=lambda: 0.0
    ) as client:
        from umiak_sdk import AsyncSandbox

        sb = AsyncSandbox(client._core, models.Sandbox.from_dict(SANDBOX))
        events = [ev async for ev in sb.run("echo ab")]
    assert "".join(e.data for e in events if isinstance(e, OutputEvent)) == "ab"
    assert isinstance(events[-1], ExitEvent)
    assert [p.split("?")[0] for p in s.paths()][:2] == [
        f"POST {SB_PATH}/commands",
        f"GET {SB_PATH}/commands/{CMD}/stream",
    ]


# --- forceStop of fork and saved snapshot (S9 §24.8) ---

REQUIRES_STOP_DETAILS = {
    "reason": "windows_running",
    "retryWith": {"forceStop": True},
    "cli": "--force-stop",
}


def requires_stop() -> httpx.Response:
    return httpx.Response(
        409,
        json={
            "error": {
                "code": "snapshot_requires_stop",
                "message": "Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true",
                "retryable": False,
                "details": REQUIRES_STOP_DETAILS,
                "requestId": "req_1",
            }
        },
    )


def test_force_stop_goes_into_the_fork_and_snapshot_bodies(clock: FakeClock) -> None:
    op = {
        **OPERATION,
        "kind": "fork",
        "forceStop": {"sourceStopped": True, "sourceRestarted": None, "restartError": None},
    }
    s = Script(
        httpx.Response(200, json=SANDBOX),
        httpx.Response(
            202, json={"sandbox": SANDBOX, "operation": OPERATION, "sourceOperation": op}
        ),
    )
    client = umiak(s)
    client.sandboxes.get("x").fork({"name": "copy"}, force_stop=True)
    assert json.loads(s.requests[1].content) == {"name": "copy", "forceStop": True}

    snap = {
        "id": "snap_1",
        "name": "s",
        "state": "creating",
        "consistency": None,
        "createdAt": "2026-10-30T07:48:37.791Z",
        "error": None,
        "readyAt": None,
        "size": None,
        "sourceSandboxId": SANDBOX["id"],
        "template": "windows",
        "templateVersion": None,
    }
    s2 = Script(
        httpx.Response(202, json={"snapshot": snap, "operation": {**op, "kind": "save_snapshot"}})
    )
    umiak(s2).snapshots.create(sandbox="x", name="s", force_stop=True)
    assert json.loads(s2.requests[0].content) == {"sandbox": "x", "name": "s", "forceStop": True}


def test_snapshot_requires_stop_raises_with_message_and_details(clock: FakeClock) -> None:
    s = Script(httpx.Response(200, json=SANDBOX), requires_stop())
    client = umiak(s)
    with pytest.raises(UmiakError) as e:
        client.sandboxes.get("x").fork()
    assert (e.value.status, e.value.code, e.value.retryable) == (
        409,
        "snapshot_requires_stop",
        False,
    )
    assert "forceStop: true" in e.value.message
    assert e.value.details == REQUIRES_STOP_DETAILS
    assert len(s.requests) == 2  # not retried

    s2 = Script(requires_stop())
    with pytest.raises(UmiakError) as e2:
        umiak(s2).snapshots.create(sandbox="x", name="s")
    assert e2.value.code == "snapshot_requires_stop"
    assert e2.value.details["retryWith"] == {"forceStop": True}
    assert "forceStop" not in json.loads(s2.requests[0].content)


def test_freshness_of_the_generated_code() -> None:
    """umiak_sdk/_gen and umiak_sdk/_sync equal a new run of scripts/gen.py."""
    import subprocess
    import sys

    root = Path(__file__).resolve().parent.parent
    r = subprocess.run(
        [sys.executable, "scripts/gen.py", "--check"],
        cwd=root,
        capture_output=True,
        text=True,
        env={**os.environ},
    )
    assert r.returncode == 0, r.stdout + r.stderr


def test_a_command_start_waits_75_s_for_the_first_byte(clock: FakeClock) -> None:
    """The api waits up to 60 s for a starting sandbox before it answers a start."""
    reads: list[float] = []

    def answer(request: httpx.Request) -> httpx.Response:
        reads.append(request.extensions["timeout"]["read"])
        return httpx.Response(
            200,
            content=ndjson(
                {"type": "started", "commandId": CMD},
                {
                    "type": "exit",
                    "status": "exited",
                    "exitCode": 0,
                    "stdoutOffset": 0,
                    "stderrOffset": 0,
                },
            ),
        )

    events = list(stream_umiak(Script(answer)).run("true"))
    assert isinstance(events[-1], ExitEvent)
    assert reads == [75.0]
