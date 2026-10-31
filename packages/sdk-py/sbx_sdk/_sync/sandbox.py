# Generated from sbx_sdk/_async/sandbox.py by scripts/gen.py; do not edit.
"""A sandbox handle (S7 §8, §15.3): waiting, commands, files, ports and the
lifecycle. Waits use the api long-polls (``?waitFor=`` and operations
``?waitSeconds=``), never frequent polling.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterator, Mapping
from typing import Any

import httpx

from .._errors import NETWORK_ERROR, WAIT_TIMEOUT, SandboxFailedError, SbxError
from .._events import READY_TIMEOUT, Encoding, ExecResult, RunEvent
from .._gen.api.operations import operations_get
from .._gen.api.ports import ports_delete, ports_list, ports_put, ports_rotate_token
from .._gen.api.sandboxes import (
    sandboxes_delete,
    sandboxes_fork,
    sandboxes_get,
    sandboxes_resume,
    sandboxes_stop,
)
from .._gen.models.hosted_port_write import HostedPortWrite
from .._gen.models.operation import Operation
from .._gen.models.port_token import PortToken
from .._gen.models.sandbox import Sandbox as SandboxData
from .._gen.models.sandbox_ports import SandboxPorts
from .._retry import new_idempotency_key
from .client import ClientCore, body_of
from .commands import Command, exec_command, run_command, start_command
from .desktop import Desktop
from .files import Files

#: Seconds of one long-poll (the api allows up to 60).
POLL_SECONDS = 30
#: A long-poll request is given up this long after its waitSeconds.
POLL_MARGIN = 15.0
#: Sandbox states that end a wait for ready with SandboxFailedError.
FAILED_STATES = frozenset({"error", "deleting", "deleted", "stopped"})
FINAL_OPERATION_STATES = frozenset({"succeeded", "failed", "superseded"})


def _wait_timeout(message: str) -> SbxError:
    return SbxError(status=0, code=WAIT_TIMEOUT, message=message, retryable=True)


def _poll_seconds(left: float) -> int:
    """waitSeconds of the next poll: 30, or less when the wait ends sooner (left may be inf)."""
    return POLL_SECONDS if left >= POLL_SECONDS else max(1, math.ceil(left))


def _long_poll(
    core: ClientCore,
    endpoint: Any,
    *args: Any,
    left: float,
    retry_budget: float | None,
    **params: Any,
) -> Any:
    """One long-poll request; None when it hung past its waitSeconds + 15 s.
    Its transport retries fit in the time left of the wait."""
    wait_seconds = params["wait_seconds"]
    budget = min(core.retry_budget if retry_budget is None else retry_budget, max(0.0, left))
    try:
        return core.call(
            endpoint,
            *args,
            retry_budget=budget,
            timeout=httpx.Timeout(60.0, connect=10.0, read=wait_seconds + POLL_MARGIN),
            **params,
        )
    except SbxError as err:
        if err.code == NETWORK_ERROR and isinstance(err.__cause__, httpx.TimeoutException):
            return None
        raise


def wait_for_operation(
    core: ClientCore,
    op: str | Operation,
    *,
    timeout: float | None = None,
    retry_budget: float | None = None,
) -> Operation:
    """Long-polls an operation until it is final (succeeded, failed, superseded)."""
    op_id = op if isinstance(op, str) else op.id
    deadline = math.inf if timeout is None else time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise _wait_timeout(f"operation {op_id} is not final yet")
        data = _long_poll(
            core,
            operations_get,
            op_id,
            left=left,
            retry_budget=retry_budget,
            wait_seconds=_poll_seconds(left),
        )
        if data is not None and str(data.state) in FINAL_OPERATION_STATES:
            return data


class Ports:
    """Published ports of a sandbox (S7 §12)."""

    def __init__(self, sandbox: Sandbox) -> None:
        self._sb = sandbox

    def host(
        self,
        port: int,
        *,
        access: str | None = None,
        host_rewrite: str | None = None,
        app_protocol: str | None = None,
        retry_budget: float | None = None,
    ) -> HostedPortWrite:
        """Publishes a port (PUT: omitted settings take their defaults); the
        token comes back only when one is issued."""
        body: dict[str, Any] = {}
        if access is not None:
            body["access"] = access
        if host_rewrite is not None:
            body["hostRewrite"] = host_rewrite
        if app_protocol is not None:
            body["appProtocol"] = app_protocol
        return self._sb.core.call(
            ports_put, self._sb.id, port, body=body_of(body), retry_budget=retry_budget
        )

    def list(self, *, retry_budget: float | None = None) -> SandboxPorts:
        return self._sb.core.call(ports_list, self._sb.id, retry_budget=retry_budget)

    def unhost(self, port: int, *, retry_budget: float | None = None) -> None:
        self._sb.core.call(ports_delete, self._sb.id, port, retry_budget=retry_budget)

    def rotate_token(self, port: int, *, retry_budget: float | None = None) -> PortToken:
        """A new token; the old one and its cookies stop working at once."""
        return self._sb.core.call(ports_rotate_token, self._sb.id, port, retry_budget=retry_budget)


class Sandbox:
    """A sandbox (``sb_...``). ``data`` is the last resource read."""

    def __init__(self, core: ClientCore, data: SandboxData) -> None:
        self.core = core
        self.data = data
        self.files = Files(self)
        self.desktop = Desktop(self)
        self.ports = Ports(self)

    def __repr__(self) -> str:
        return f"Sandbox({self.id!r}, slug={self.slug!r}, state={self.state!r})"

    @property
    def id(self) -> str:
        return self.data.id

    @property
    def slug(self) -> str:
        return self.data.slug

    @property
    def state(self) -> str:
        return str(self.data.state)

    def refresh(self, *, retry_budget: float | None = None) -> SandboxData:
        self.data = self.core.call(sandboxes_get, self.id, retry_budget=retry_budget)
        return self.data

    def wait_until_ready(
        self, *, timeout: float = READY_TIMEOUT, retry_budget: float | None = None
    ) -> Sandbox:
        """Waits for ready by long-poll. SandboxFailedError when the sandbox
        becomes error, deleting, deleted or stopped; ``wait_timeout`` after
        ``timeout`` seconds (default 300)."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise _wait_timeout(f"sandbox {self.slug} is still {self.state}")
            # Answers at once when the state is already ready, stopped or final.
            data = _long_poll(
                self.core,
                sandboxes_get,
                self.id,
                left=left,
                retry_budget=retry_budget,
                wait_for="ready,stopped",
                wait_seconds=_poll_seconds(left),
            )
            if data is None:
                continue
            self.data = data
            if self.state == "ready":
                return self
            if self.state in FAILED_STATES:
                raise SandboxFailedError(
                    status=409,
                    code="sandbox_failed",
                    message=f"sandbox {self.slug} is {self.state}, not ready",
                    retryable=False,
                    details={"state": self.state, "sandboxId": self.id},
                )

    def wait_for_operation(
        self,
        op: str | Operation,
        *,
        timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation:
        return wait_for_operation(self.core, op, timeout=timeout, retry_budget=retry_budget)

    def exec(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        user: str | None = None,
        timeout_seconds: int | None = None,
        tags: Mapping[str, str] | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
    ) -> ExecResult:
        """Runs a command and returns its output in the shape of a sync result
        (the last 4 MiB per stream). Sent as ``mode: stream`` with an
        Idempotency-Key, so a retry never starts it twice and no proxy cuts a
        silent request; breaks are resumed like ``run``. A string is run by the
        shell, a list is an argv."""
        return exec_command(
            self,
            cmd,
            cwd=cwd,
            env=env,
            user=user,
            timeout_seconds=timeout_seconds,
            tags=tags,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
        )

    def run(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        user: str | None = None,
        timeout_seconds: int | None = None,
        tags: Mapping[str, str] | None = None,
        encoding: Encoding = "utf8",
        on_start: Callable[[Command], Any] | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
    ) -> Iterator[RunEvent]:
        """Runs a command and yields its output events (OutputEvent,
        TruncatedEvent, then ExitEvent); breaks are resumed by offset.
        ``on_start`` gets the command once it is known. ``retry_budget``
        bounds the start (POST until the command id is known)."""
        return run_command(
            self,
            cmd,
            cwd=cwd,
            env=env,
            user=user,
            timeout_seconds=timeout_seconds,
            tags=tags,
            encoding=encoding,
            on_start=on_start,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
        )

    def start(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        user: str | None = None,
        timeout_seconds: int | None = None,
        tags: Mapping[str, str] | None = None,
        stdin: bool | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
    ) -> Command:
        """Starts a detached command; follow it with ``Command.follow``.
        ``stdin``: keep stdin open for ``Command.input``."""
        return start_command(
            self,
            cmd,
            cwd=cwd,
            env=env,
            user=user,
            timeout_seconds=timeout_seconds,
            tags=tags,
            stdin=stdin,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
        )

    def command(self, id: str) -> Command:
        """A handle of an existing command (``cmd_...``); nothing is fetched."""
        return Command(self, id)

    def stop(
        self,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation:
        """Stops the sandbox; returns the stop operation (``wait``: once it is final)."""
        action = self.core.call(sandboxes_stop, self.id, retry_budget=retry_budget)
        self.data = action.sandbox
        return self._after(action.operation, wait, wait_timeout, retry_budget)

    def resume(
        self,
        input: Mapping[str, Any] | Any = None,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation:
        """Resumes a stopped sandbox (``wait``: until it is ready)."""
        action = self.core.call(
            sandboxes_resume, self.id, body=body_of(input), retry_budget=retry_budget
        )
        self.data = action.sandbox
        if wait:
            self.wait_until_ready(
                timeout=READY_TIMEOUT if wait_timeout is None else wait_timeout,
                retry_budget=retry_budget,
            )
        return action.operation

    def fork(
        self,
        input: Mapping[str, Any] | Any = None,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        force_stop: bool | None = None,
    ) -> Sandbox:
        """A copy of this sandbox (keyed POST; ``wait``: until the copy is ready).

        A running Windows sandbox is forked only from a stopped VM: without
        ``force_stop`` it raises SbxError 409 ``snapshot_requires_stop``
        (``details["retryWith"] == {"forceStop": True}``). ``force_stop=True``
        stops this sandbox (running commands and sessions are interrupted),
        takes the snapshot and starts it again; the fork operation's
        ``force_stop`` reports the restart. Ignored for Linux and for a
        stopped sandbox."""
        body = input
        if force_stop is not None:
            body = input.to_dict() if hasattr(input, "to_dict") else dict(input or {})
            body["forceStop"] = force_stop
        fork = self.core.call(
            sandboxes_fork,
            self.id,
            body=body_of(body),
            retry_budget=retry_budget,
            idempotency_key=idempotency_key or new_idempotency_key(),
        )
        copy = Sandbox(self.core, fork.sandbox)
        if wait:
            copy.wait_until_ready(
                timeout=READY_TIMEOUT if wait_timeout is None else wait_timeout,
                retry_budget=retry_budget,
            )
        return copy

    def delete(
        self,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation | None:
        """Deletes the sandbox (a running one too: no stop needed), with
        ``Sbx-Confirm-Delete`` set to its id. Returns the delete operation, or
        None when it was already deleted (``wait``: once it is final)."""
        result = self.core.call(
            sandboxes_delete, self.id, sbx_confirm_delete=self.id, retry_budget=retry_budget
        )
        self.data = result.sandbox
        if result.operation is None:
            return None
        return self._after(result.operation, wait, wait_timeout, retry_budget)

    def stop_and_delete(
        self,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation | None:
        """The same as ``delete`` (S7 §15.4: a delete needs no stop first)."""
        return self.delete(wait=wait, wait_timeout=wait_timeout, retry_budget=retry_budget)

    def _after(
        self,
        op: Operation,
        wait: bool,
        wait_timeout: float | None,
        retry_budget: float | None,
    ) -> Operation:
        if not wait:
            return op
        done = self.wait_for_operation(op, timeout=wait_timeout, retry_budget=retry_budget)
        self.refresh(retry_budget=retry_budget)
        return done
