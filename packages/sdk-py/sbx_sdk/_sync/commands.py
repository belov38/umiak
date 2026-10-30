# Generated from sbx_sdk/_async/commands.py by scripts/gen.py; do not edit.
"""Commands (S7 §9, §15.4): exec, run, start, follow and the command handle.

Resumable streams: ``run`` sends ``POST /commands`` with ``mode: stream`` and
an Idempotency-Key, ``follow`` opens ``GET .../stream``. After a break
(network error, no byte for 45 s, ``error {retryable: true}``, ``reconnect``)
the stream is reopened with ``GET .../stream`` from the last offsets; the
command is never started twice. Until the command id is known every attempt
is the keyed POST, bounded as a whole by the call's retry budget. After that
there is no overall time limit while output arrives; 20 attempts in a row
without new bytes end with the last error. Leaving the loop early closes the
connection and leaves the command running.
"""

from __future__ import annotations

import base64
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import closing
from typing import TYPE_CHECKING, Any, Literal

import httpx

from .._errors import (
    NETWORK_ERROR,
    PROTOCOL_ERROR,
    UNEXPECTED_RESPONSE,
    WAIT_TIMEOUT,
    SbxError,
    broken,
    frame_error,
)
from .._events import (
    Encoding,
    ExecResult,
    ExitEvent,
    Offsets,
    OutputChunk,
    OutputEvent,
    OutputStream,
    RunEvent,
    Tail,
    TruncatedEvent,
)
from .._gen.api.commands import (
    commands_create,
    commands_get,
    commands_input,
    commands_kill,
    commands_output,
    commands_signal,
    commands_stream,
)
from .._gen.models.command import Command as CommandData
from .._gen.models.commands_output_stream import CommandsOutputStream
from .._gen.models.commands_stream_encoding import CommandsStreamEncoding
from .._gen.models.commands_stream_follow import CommandsStreamFollow
from .._ndjson import NdjsonDecoder
from .._retry import MAX_FAILURES, is_retryable, new_idempotency_key, over_budget, retry_delay
from ._io import sleep
from .client import body_of

if TYPE_CHECKING:
    from .sandbox import Sandbox

_NETWORK_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)


def _command_body(cmd: str | list[str]) -> dict[str, Any]:
    return {"command": cmd} if isinstance(cmd, str) else {"argv": list(cmd)}


def _spec(
    cwd: str | None,
    env: Mapping[str, str] | None,
    user: str | None,
    timeout_seconds: int | None,
    tags: Mapping[str, str] | None,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if cwd is not None:
        out["cwd"] = cwd
    if env is not None:
        out["env"] = dict(env)
    if user is not None:
        out["user"] = user
    if timeout_seconds is not None:
        out["timeoutSeconds"] = timeout_seconds
    if tags is not None:
        out["tags"] = dict(tags)
    return out


def _stream_timeout(idle: float) -> httpx.Timeout:
    # The read timeout is the idle limit: no byte for that long is a dead connection.
    return httpx.Timeout(60.0, connect=10.0, read=idle)


# The api waits up to 60 s for a creating/starting sandbox before it answers
# a command start (S7 §9.1): the first byte may come that late.
START_READ_TIMEOUT = 60.0 + 15.0


def _start_timeout(idle: float) -> httpx.Timeout:
    return httpx.Timeout(60.0, connect=10.0, read=max(idle, START_READ_TIMEOUT))


class Command:
    """A command of a sandbox (``cmd_...``)."""

    def __init__(self, sandbox: Sandbox, id: str, data: CommandData | None = None) -> None:
        self._sb = sandbox
        self.id = id
        #: The last resource read, if any.
        self.data = data

    def __repr__(self) -> str:
        return f"Command({self.id!r}, sandbox={self._sb.id!r})"

    @property
    def sandbox_id(self) -> str:
        return self._sb.id

    def refresh(self, *, retry_budget: float | None = None) -> CommandData:
        """GET the resource (live fields while the sandbox is ready)."""
        self.data = self._sb.core.call(
            commands_get, self._sb.id, self.id, retry_budget=retry_budget
        )
        return self.data

    def follow(
        self,
        *,
        start: Literal["start", "end"] | Offsets = "start",
        encoding: Encoding = "utf8",
        timeout: float | None = None,
    ) -> Iterator[RunEvent]:
        """Output events from ``start`` ("start": all output, "end": only new
        output, or offsets) until the exit, reattaching after breaks.
        ``timeout`` (seconds): ``wait_timeout`` if the exit has not come by then."""
        offsets = (
            Offsets(start.stdout, start.stderr, start.pty)
            if isinstance(start, Offsets)
            else Offsets()
        )
        return _resumable(
            self._sb,
            _Plan(
                encoding=encoding,
                offsets=offsets,
                retry_budget=None,
                command_id=self.id,
                tail_bytes=0 if start == "end" else None,
                deadline=None if timeout is None else time.monotonic() + timeout,
            ),
        )

    def wait(self, *, timeout: float | None = None) -> ExitEvent:
        """Waits for the exit (output is skipped); ``wait_timeout`` after
        ``timeout`` seconds (the command keeps running)."""
        with closing(self.follow(start="end", timeout=timeout)) as events:  # type: ignore[type-var]
            for ev in events:
                if isinstance(ev, ExitEvent):
                    return ev
        raise SbxError(
            status=0,
            code=UNEXPECTED_RESPONSE,
            message="the stream ended without exit",
            retryable=False,
        )

    def kill(
        self, *, grace_ms: int | None = None, retry_budget: float | None = None
    ) -> CommandData:
        """SIGTERM, then SIGKILL after ``grace_ms`` (default 10 000)."""
        body = {} if grace_ms is None else {"graceMs": grace_ms}
        self.data = self._sb.core.call(
            commands_kill, self._sb.id, self.id, body=body_of(body), retry_budget=retry_budget
        )
        return self.data

    def signal(self, signal: str, *, retry_budget: float | None = None) -> CommandData:
        """Sends a signal (SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2)."""
        self.data = self._sb.core.call(
            commands_signal,
            self._sb.id,
            self.id,
            body=body_of({"signal": signal}),
            retry_budget=retry_budget,
        )
        return self.data

    def input(
        self,
        data: str | bytes,
        *,
        close_stdin: bool | None = None,
        session_id: str | None = None,
        seq: int | None = None,
        retry_budget: float | None = None,
    ) -> None:
        """Writes to stdin (or the PTY). With ``session_id`` and ``seq`` a repeat
        is applied once (and retried after network errors); without them it is not."""
        body: dict[str, Any] = (
            {"data": data, "encoding": "utf8"}
            if isinstance(data, str)
            else {"data": base64.b64encode(data).decode("ascii"), "encoding": "base64"}
        )
        if close_stdin is not None:
            body["closeStdin"] = close_stdin
        if session_id is not None:
            body["sessionId"] = session_id
        if seq is not None:
            body["seq"] = seq
        keyed = session_id is not None and seq is not None
        self._sb.core.call(
            commands_input,
            self._sb.id,
            self.id,
            body=body_of(body),
            retry_budget=retry_budget,
            # The api drops repeats of a (sessionId, seq): safe to repeat.
            idempotency_key=f"{session_id}:{seq}" if keyed else None,
        )

    def output(
        self,
        stream: OutputStream = "stdout",
        offset: int = 0,
        limit: int = 1024 * 1024,
        *,
        retry_budget: float | None = None,
    ) -> OutputChunk:
        """Raw bytes of one stream (GET .../output; ``limit`` up to 4 MiB)."""
        resp = self._sb.core.send(
            commands_output._get_kwargs(
                self._sb.id,
                self.id,
                stream=CommandsOutputStream(stream),
                offset=offset,
                limit=limit,
            ),
            retry_budget=retry_budget,
        )
        h = resp.headers
        data = resp.content
        start = int(h.get("Sbx-Offset", offset))
        end = h.get("Sbx-Stream-End")
        return OutputChunk(
            data=data,
            offset=start,
            next_offset=int(h.get("Sbx-Next-Offset", start + len(data))),
            available_from=int(h.get("Sbx-Available-From", 0)),
            end=None if end is None else int(end),
            truncated=h.get("Sbx-Truncated") == "true",
        )


def exec_command(
    sb: Sandbox,
    cmd: str | list[str],
    *,
    cwd: str | None,
    env: Mapping[str, str] | None,
    user: str | None,
    timeout_seconds: int | None,
    tags: Mapping[str, str] | None,
    retry_budget: float | None,
    idempotency_key: str | None,
) -> ExecResult:
    """A stream command collected into the shape of a sync result."""
    started: list[Command] = []
    tails = {"stdout": Tail(), "stderr": Tail()}
    exit_ev: ExitEvent | None = None
    # Closed at once also when the loop ends early (an error in the body).
    with closing(
        run_command(
            sb,
            cmd,
            cwd=cwd,
            env=env,
            user=user,
            timeout_seconds=timeout_seconds,
            tags=tags,
            encoding="utf8",
            on_start=started.append,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
        )  # type: ignore[type-var]
    ) as events:
        for ev in events:
            if isinstance(ev, ExitEvent):
                exit_ev = ev
            elif isinstance(ev, TruncatedEvent):
                if ev.stream != "pty":
                    tails[ev.stream].drop(ev.available_from)
            elif ev.type != "pty":
                assert isinstance(ev.data, str)
                tails[ev.type].push(ev.data, ev.next_offset)
    if exit_ev is None or not started:
        raise SbxError(
            status=0,
            code=UNEXPECTED_RESPONSE,
            message="the command stream ended without exit",
            retryable=False,
        )
    data = started[0].refresh(retry_budget=retry_budget)
    return ExecResult(
        command=data,
        stdout=tails["stdout"].text(),
        stderr=tails["stderr"].text(),
        exit_code=exit_ev.exit_code,
        stdout_truncated=tails["stdout"].truncated,
        stderr_truncated=tails["stderr"].truncated,
        stdout_from=tails["stdout"].start,
        stderr_from=tails["stderr"].start,
        output_truncated=exit_ev.output_truncated,
    )


def run_command(
    sb: Sandbox,
    cmd: str | list[str],
    *,
    cwd: str | None,
    env: Mapping[str, str] | None,
    user: str | None,
    timeout_seconds: int | None,
    tags: Mapping[str, str] | None,
    encoding: Encoding,
    on_start: Callable[[Command], Any] | None,
    retry_budget: float | None,
    idempotency_key: str | None,
) -> Iterator[RunEvent]:
    """POST /commands in stream mode, then the resumable stream."""
    # One key for every POST of this run: the command starts at most once.
    key = idempotency_key or new_idempotency_key()
    body = {
        **_command_body(cmd),
        **_spec(cwd, env, user, timeout_seconds, tags),
        "mode": "stream",
        "encoding": encoding,
    }
    core = sb.core

    def start(budget_left: float) -> Any:
        return core.stream(
            commands_create._get_kwargs(sb.id, body=body_of(body)),
            idempotency_key=key,
            retry_budget=budget_left,
            timeout=_start_timeout(core.stream_idle_timeout),
        )

    return _resumable(
        sb,
        _Plan(
            encoding=encoding,
            offsets=Offsets(),
            retry_budget=retry_budget,
            start=start,
            on_start=on_start,
        ),
    )


def start_command(
    sb: Sandbox,
    cmd: str | list[str],
    *,
    cwd: str | None,
    env: Mapping[str, str] | None,
    user: str | None,
    timeout_seconds: int | None,
    tags: Mapping[str, str] | None,
    stdin: bool | None,
    retry_budget: float | None,
    idempotency_key: str | None,
) -> Command:
    """A detached command (POST /commands, mode detached, keyed)."""
    body = {**_command_body(cmd), **_spec(cwd, env, user, timeout_seconds, tags)}
    if stdin is not None:
        body["stdin"] = stdin
    body["mode"] = "detached"
    data = sb.core.call(
        commands_create,
        sb.id,
        body=body_of(body),
        retry_budget=retry_budget,
        idempotency_key=idempotency_key or new_idempotency_key(),
        timeout=_start_timeout(sb.core.stream_idle_timeout),
    )
    return Command(sb, data.id, data)


class _Plan:
    def __init__(
        self,
        *,
        encoding: Encoding,
        offsets: Offsets,
        retry_budget: float | None,
        command_id: str | None = None,
        tail_bytes: int | None = None,
        start: Callable[[float], Any] | None = None,
        on_start: Callable[[Command], Any] | None = None,
        deadline: float | None = None,
    ) -> None:
        self.encoding = encoding
        #: time.monotonic() after which the stream ends with wait_timeout.
        self.deadline = deadline
        #: Updated as output arrives.
        self.offsets = offsets
        self.retry_budget = retry_budget
        #: Known for follow; for run it comes from the first answer.
        self.command_id = command_id
        #: First /stream only: start each stream this many bytes before its end.
        self.tail_bytes = tail_bytes
        #: Opens the first stream (run: POST /commands) with the budget left.
        self.start = start
        self.on_start = on_start


def _get_offset(o: Offsets, stream: str) -> int:
    v = getattr(o, stream)
    return 0 if v is None else v


def _set_offsets(o: Offsets, f: Mapping[str, Any]) -> None:
    for stream in ("stdout", "stderr", "pty"):
        v = f.get(f"{stream}Offset")
        if isinstance(v, int):
            setattr(o, stream, v)


def _exit_event(f: Mapping[str, Any]) -> ExitEvent:
    def text(k: str) -> str | None:
        v = f.get(k)
        return v if isinstance(v, str) else None

    pty = f.get("ptyOffset")
    code = f.get("exitCode")
    return ExitEvent(
        status=str(f.get("status")),
        exit_code=code if isinstance(code, int) else None,
        signal=text("signal"),
        reason=text("reason"),
        stdout_offset=int(f.get("stdoutOffset") or 0),
        stderr_offset=int(f.get("stderrOffset") or 0),
        pty_offset=pty if isinstance(pty, int) else None,
        output_truncated=text("outputTruncated"),
    )


def _protocol_error(message: str) -> SbxError:
    """Frames that do not fit the offsets: reattach from the tracked offsets."""
    return SbxError(
        status=0, code=PROTOCOL_ERROR, message=f"command stream: {message}", retryable=True
    )


def _open_stream(sb: Sandbox, plan: _Plan, command_id: str, tail_bytes: int | None) -> Any:
    o = plan.offsets
    params: dict[str, Any] = {
        "follow": CommandsStreamFollow.TRUE,
        "encoding": CommandsStreamEncoding(plan.encoding),
    }
    if tail_bytes is not None:
        params["tail_bytes"] = tail_bytes
    else:
        params["stdout_offset"] = o.stdout
        params["stderr_offset"] = o.stderr
    if o.pty is not None:
        params["pty_offset"] = o.pty
    idle = sb.core.stream_idle_timeout
    if plan.deadline is not None:
        # A read stops at the deadline too; the loop then ends with wait_timeout.
        idle = max(0.05, min(idle, plan.deadline - time.monotonic()))
    return sb.core.stream(
        commands_stream._get_kwargs(sb.id, command_id, **params),
        # The stream loop counts attempts itself (S7 §15.4).
        retry_budget=0,
        timeout=_stream_timeout(idle),
    )


def _idle_body_reads(resp: httpx.Response, idle: float) -> None:
    """A start waits up to START_READ_TIMEOUT for its answer; once the headers
    are in, the body reads use the idle limit (httpcore reads the request's
    ``timeout`` extension when the body iteration begins)."""
    t = resp.request.extensions.get("timeout")
    if isinstance(t, dict) and isinstance(t.get("read"), int | float) and t["read"] > idle:
        resp.request.extensions["timeout"] = {**t, "read": idle}


def _check_deadline(plan: _Plan) -> None:
    if plan.deadline is not None and time.monotonic() >= plan.deadline:
        raise SbxError(
            status=0,
            code=WAIT_TIMEOUT,
            message="the command did not exit within the timeout; it keeps running",
            retryable=True,
        )


def _resumable(sb: Sandbox, plan: _Plan) -> Iterator[RunEvent]:
    core = sb.core
    offsets = plan.offsets
    command_id = plan.command_id
    tail_bytes = plan.tail_bytes
    failures = 0
    start_budget = core.retry_budget if plan.retry_budget is None else plan.retry_budget
    started_at = time.monotonic()
    while True:
        _check_deadline(plan)
        progressed = False
        reconnect = False
        last_error: SbxError | None = None
        try:
            if command_id is None:
                assert plan.start is not None
                left = max(0.0, start_budget - (time.monotonic() - started_at))
                cm = plan.start(left)
            else:
                cm = _open_stream(sb, plan, command_id, tail_bytes)
            with cm as resp:
                _idle_body_reads(resp, core.stream_idle_timeout)
                if command_id is None:
                    cid = resp.headers.get("Sbx-Command-Id")
                    if cid:
                        command_id = cid
                        if plan.on_start is not None:
                            plan.on_start(Command(sb, cid))
                decoder = NdjsonDecoder()
                stop = False
                for chunk in resp.iter_bytes():
                    for f in decoder.feed(chunk):
                        t = f.get("type")
                        if t == "started":
                            cid = f.get("commandId")
                            if command_id is None and isinstance(cid, str):
                                command_id = cid
                                if plan.on_start is not None:
                                    plan.on_start(Command(sb, cid))
                        elif t == "attached":
                            _set_offsets(offsets, f)
                            # From here on, reattach from the offsets.
                            tail_bytes = None
                        elif t in ("stdout", "stderr", "pty"):
                            at = _get_offset(offsets, t)
                            first = int(f.get("offset") or 0)
                            nxt = int(f.get("nextOffset") or 0)
                            if nxt <= at:
                                continue  # already delivered
                            raw = str(f.get("data") or "")
                            data: str | bytes = (
                                base64.b64decode(raw) if plan.encoding == "base64" else raw
                            )
                            if first != at:
                                # base64 frames can be cut at the tracked byte; a utf8
                                # frame cannot (its text is not bytes), and a gap is never right.
                                if first > at or plan.encoding != "base64":
                                    raise _protocol_error(f"{t} frame at {first}, expected {at}")
                                assert isinstance(data, bytes)
                                data = data[at - first :]
                            setattr(offsets, t, nxt)
                            progressed = True
                            failures = 0
                            yield OutputEvent(type=t, data=data, offset=at, next_offset=nxt)
                        elif t == "truncated":
                            stream = str(f.get("stream"))
                            frm = int(f.get("availableFrom") or 0)
                            if stream in ("stdout", "stderr", "pty"):
                                setattr(offsets, stream, frm)
                            progressed = True
                            failures = 0
                            yield TruncatedEvent(stream=stream, available_from=frm)  # type: ignore[arg-type]
                        elif t == "exit":
                            yield _exit_event(f)
                            return
                        elif t == "reconnect":
                            _set_offsets(offsets, f)
                            reconnect = True
                            last_error = SbxError(
                                status=0,
                                code=NETWORK_ERROR,
                                message=f"the api asked to reconnect ({f.get('reason')})",
                                retryable=True,
                            )
                            stop = True
                            break
                        elif t == "error":
                            err = frame_error(f)
                            if not err.retryable:
                                raise err
                            last_error = err
                            stop = True
                            break
                        # heartbeat and frame types this SDK does not know: skipped
                    if stop:
                        break
                    _check_deadline(plan)
                if not stop:
                    decoder.end()
            if last_error is None:
                last_error = broken("the command stream ended without exit")
        except _NETWORK_ERRORS as err:
            _check_deadline(plan)
            why = (
                f"no stream data for {core.stream_idle_timeout:g} s: connection dead"
                if isinstance(err, httpx.TimeoutException)
                else f"the command stream broke: {err or type(err).__name__}"
            )
            last_error = broken(why)
            last_error.__cause__ = err
        except SbxError as err:
            # Both the keyed POST and GET /stream are safe to repeat, so a proxy
            # 502/503/504/429 without the envelope is retried too.
            if not is_retryable(err, True):
                raise
            last_error = err
        assert last_error is not None
        if not progressed:
            failures += 1
        if failures >= MAX_FAILURES:
            raise last_error
        wait = (
            0.0
            if reconnect and failures <= 1
            else retry_delay(last_error, max(0, failures - 1), core.random)
        )
        if command_id is None and over_budget(start_budget, time.monotonic() - started_at, wait):
            raise last_error
        if plan.deadline is not None:
            wait = min(wait, max(0.0, plan.deadline - time.monotonic()))
        if wait > 0:
            sleep(wait)
