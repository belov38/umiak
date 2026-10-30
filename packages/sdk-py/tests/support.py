"""Helpers of the sbx-sdk tests: the control client of tests/api_server.ts
and the facade under test (``Sbx``, or ``AsyncSbx`` through ``Blocking``,
which runs every coroutine and async iterator of the asyncio facade on one
event loop, so one scenario checks both facades).
"""

from __future__ import annotations

import asyncio
import inspect
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx


class TestApi:
    """The running api and its control endpoints."""

    __test__ = False

    def __init__(self, info: dict[str, str]) -> None:
        self.url = info["url"]
        self.api_url = info["apiUrl"]
        self.secret = info["secret"]
        self._control = httpx.Client(base_url=info["control"], timeout=30)

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        r = self._control.post(path, json=body)
        r.raise_for_status()
        return r.json()

    def _get(self, path: str, **params: Any) -> Any:
        r = self._control.get(path, params=params)
        r.raise_for_status()
        return r.json()

    def requests(self, since: int = 0) -> list[dict[str, Any]]:
        """Requests the proxy received (method, path with query, lower-case headers)."""
        return self._get("/requests", since=since)

    def request_count(self) -> int:
        return self._get("/requests/count")["count"]

    def fault(self, action: str, **match: Any) -> None:
        """A one-shot fault: replace | cut | stall | drop (see api_server.ts)."""
        self._post("/faults", {"action": action, **match})

    def clear_faults(self) -> None:
        self._control.delete("/faults").raise_for_status()

    def creating(self) -> list[str]:
        return self._get("/creating")["slugs"]

    def mark_ready(self, slug: str) -> None:
        self._post("/mark-ready", {"slug": slug})

    def fail_operation(self, slug: str, kind: str, code: str, message: str) -> bool:
        return self._post(
            "/fail-operation", {"slug": slug, "kind": kind, "code": code, "message": message}
        )["ok"]

    def start_count(self, command_id: str) -> int:
        return self._get("/start-count", command=command_id)["count"]

    def fail_next_attach(self, slug: str, after_bytes: int, kind: str) -> None:
        self._post("/fail-next-attach", {"slug": slug, "afterBytes": after_bytes, "kind": kind})

    def key(self, scopes: list[str] | None = None) -> str:
        return self._post("/key", {} if scopes is None else {"scopes": scopes})["secret"]

    def close(self) -> None:
        self._control.close()


def until(fn: Callable[[], Any], timeout: float = 10.0, what: str = "condition") -> Any:
    """Polls ``fn`` until it returns a truthy value."""
    end = time.monotonic() + timeout
    while True:
        v = fn()
        if v:
            return v
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.02)


class Blocking:
    """Drives an object of the asyncio facade with blocking calls: coroutines
    run on ``loop``, async iterators become iterators, facade objects and
    callback arguments are wrapped the same way."""

    def __init__(self, obj: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._obj = obj
        self._loop = loop

    def __getattr__(self, name: str) -> Any:
        return _blocking(getattr(self._obj, name), self._loop)

    def __repr__(self) -> str:
        return f"Blocking({self._obj!r})"


def _blocking(v: Any, loop: asyncio.AbstractEventLoop) -> Any:
    if inspect.iscoroutine(v):
        return _blocking(loop.run_until_complete(v), loop)
    if hasattr(v, "__anext__"):
        return _iterate(v, loop)
    if inspect.ismethod(v) or inspect.isfunction(v):

        def call(*args: Any, **kwargs: Any) -> Any:
            kwargs = {
                k: (_callback(a, loop) if callable(a) and k.startswith("on_") else a)
                for k, a in kwargs.items()
            }
            return _blocking(v(*args, **kwargs), loop)

        return call
    if type(v).__module__.startswith("sbx_sdk._async"):
        return Blocking(v, loop)
    return v


def _callback(fn: Callable[..., Any], loop: asyncio.AbstractEventLoop) -> Callable[..., Any]:
    return lambda *args: fn(*(_blocking(a, loop) for a in args))


def _iterate(agen: Any, loop: asyncio.AbstractEventLoop) -> Iterator[Any]:
    try:
        while True:
            try:
                item = loop.run_until_complete(agen.__anext__())
            except StopAsyncIteration:
                return
            yield _blocking(item, loop)
    finally:
        loop.run_until_complete(agen.aclose())


class Client:
    """A facade under test plus how to make more of the same kind."""

    def __init__(self, kind: str, api: TestApi) -> None:
        self.kind = kind
        self.api = api
        self._loop = asyncio.new_event_loop() if kind == "async" else None
        self._made: list[Any] = []
        self.sbx = self.make()

    def make(self, **opts: Any) -> Any:
        """A new facade of this kind against the test api (``opts`` override)."""
        from sbx_sdk import AsyncSbx, Sbx

        kw: dict[str, Any] = {"base_url": self.api.url, "api_key": self.api.secret, "env": {}}
        kw.update(opts)
        if self._loop is None:
            made = Sbx(**kw)
            self._made.append(made)
            return made
        made = AsyncSbx(**kw)
        self._made.append(made)
        return Blocking(made, self._loop)

    def in_thread(self, fn: Callable[[], Any]) -> Callable[[], Any]:
        """Runs ``fn`` in a thread; returns a function that waits for its result."""
        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["value"] = fn()
            except BaseException as err:
                box["error"] = err

        t = threading.Thread(target=run, daemon=True)
        t.start()

        def result(timeout: float = 60.0) -> Any:
            t.join(timeout)
            if t.is_alive():
                raise AssertionError("the call did not finish")
            if "error" in box:
                raise box["error"]
            return box.get("value")

        return result

    def close(self) -> None:
        for made in self._made:
            if self._loop is None:
                made.close()
            else:
                self._loop.run_until_complete(made.aclose())
        if self._loop is not None:
            self._loop.close()
