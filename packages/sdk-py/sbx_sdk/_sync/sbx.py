# Generated from sbx_sdk/_async/sbx.py by scripts/gen.py; do not edit.
"""The blocking facade (S7 §15.3): ``Sbx``.

    with Sbx(base_url=..., api_key=...) as sbx:   # or the credential chain
        sb = sbx.sandboxes.create(template="linux", wait=True)
        r = sb.exec("npm test")
        for s in sbx.sandboxes.list(label={"session": "42"}):
            ...

Every call takes ``retry_budget`` (seconds of retries for that call instead
of the default 60); keyed calls also take ``idempotency_key``. ``sbx.raw`` is
the generated client (``sbx_sdk._gen``) with the same transport.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any

import httpx

from .._errors import SbxError
from .._events import READY_TIMEOUT
from .._gen.api.account import limits_get, me_get
from .._gen.api.catalog import sizes_list, templates_list
from .._gen.api.sandboxes import sandboxes_create, sandboxes_get, sandboxes_list
from .._gen.api.snapshots import snapshots_create, snapshots_delete, snapshots_get, snapshots_list
from .._gen.client import Client as GenClient
from .._gen.models.limits import Limits
from .._gen.models.me import Me
from .._gen.models.operation import Operation
from .._gen.models.sandbox import Sandbox as SandboxData
from .._gen.models.size import Size
from .._gen.models.snapshot import Snapshot
from .._gen.models.template import Template
from .._gen.types import UNSET
from .._retry import new_idempotency_key
from .client import ClientCore, TokenProvider, body_of
from .sandbox import Sandbox, wait_for_operation


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _fields(input: Any, fields: Mapping[str, Any]) -> Any:
    """A request body from a model or a dict (API field names) plus keyword
    fields (snake_case, converted to camelCase; values are sent as is)."""
    if not fields:
        return body_of(input)
    base = input.to_dict() if hasattr(input, "to_dict") else dict(input or {})
    base.update({_camel(k): v for k, v in fields.items()})
    return body_of(base)


class Sandboxes:
    def __init__(self, core: ClientCore) -> None:
        self._core = core

    def create(
        self,
        input: Mapping[str, Any] | Any = None,
        /,
        *,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        **fields: Any,
    ) -> Sandbox:
        """Creates a sandbox (keyed POST). The body is ``input`` (a
        CreateSandboxRequest or a dict with API field names) and/or keyword
        fields: ``create(template="linux", labels={"a": "1"}, ttl_seconds=600)``.
        ``wait``: until it is ready (SandboxFailedError if it fails)."""
        action = self._core.call(
            sandboxes_create,
            body=_fields(input, fields),
            retry_budget=retry_budget,
            idempotency_key=idempotency_key or new_idempotency_key(),
        )
        sb = Sandbox(self._core, action.sandbox)
        if wait:
            sb.wait_until_ready(
                timeout=READY_TIMEOUT if wait_timeout is None else wait_timeout,
                retry_budget=retry_budget,
            )
        return sb

    def get(self, ref: str, *, retry_budget: float | None = None) -> Sandbox:
        """By id (``sb_...``) or slug."""
        data = self._core.call(sandboxes_get, ref, retry_budget=retry_budget)
        return Sandbox(self._core, data)

    def list(
        self,
        *,
        state: str | Sequence[str] | None = None,
        label: Mapping[str, str] | None = None,
        template: str | None = None,
        q: str | None = None,
        limit: int | None = None,
        retry_budget: float | None = None,
    ) -> Iterator[SandboxData]:
        """Every sandbox of the team matching the filter, newest first, all
        pages (``limit`` is the page size). ``label``: every label must match;
        ``q``: search in slug and name."""
        cursor: str | None = None
        while True:
            page = self._core.call(
                sandboxes_list,
                state=UNSET
                if state is None
                else (state if isinstance(state, str) else ",".join(state)),
                label=UNSET if label is None else [f"{k}={v}" for k, v in label.items()],
                template=UNSET if template is None else template,
                q=UNSET if q is None else q,
                limit=UNSET if limit is None else limit,
                cursor=UNSET if cursor is None else cursor,
                retry_budget=retry_budget,
            )
            for s in page.data:
                yield s
            cursor = page.next_cursor
            if not cursor:
                return


class Snapshots:
    def __init__(self, core: ClientCore) -> None:
        self._core = core

    def create(
        self,
        *,
        sandbox: str,
        name: str,
        wait: bool = False,
        wait_timeout: float | None = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        force_stop: bool | None = None,
        **fields: Any,
    ) -> Snapshot:
        """Saves a snapshot of a sandbox (keyed POST). ``wait``: until the
        operation is final; a failed one raises its error.

        A running Windows sandbox is saved only from a stopped VM: without
        ``force_stop`` it raises SbxError 409 ``snapshot_requires_stop``
        (``details["retryWith"] == {"forceStop": True}``). ``force_stop=True``
        stops the sandbox (running commands and sessions are interrupted),
        takes the snapshot and starts it again; the operation's ``force_stop``
        reports the restart. Ignored for Linux and for a stopped sandbox."""
        if force_stop is not None:
            fields = {**fields, "force_stop": force_stop}
        created = self._core.call(
            snapshots_create,
            body=_fields({"sandbox": sandbox, "name": name}, fields),
            retry_budget=retry_budget,
            idempotency_key=idempotency_key or new_idempotency_key(),
        )
        if not wait:
            return created.snapshot
        op = wait_for_operation(
            self._core, created.operation, timeout=wait_timeout, retry_budget=retry_budget
        )
        if str(op.state) != "succeeded":
            raise _operation_failed(op)
        return self.get(name, retry_budget=retry_budget)

    def get(self, name: str, *, retry_budget: float | None = None) -> Snapshot:
        return self._core.call(snapshots_get, name, retry_budget=retry_budget)

    def list(self, *, retry_budget: float | None = None) -> Iterator[Snapshot]:
        page = self._core.call(snapshots_list, retry_budget=retry_budget)
        for s in page.data:
            yield s

    def delete(self, name: str, *, retry_budget: float | None = None) -> None:
        """Deletes a saved snapshot; ``Sbx-Confirm-Delete`` is its id (read first)."""
        snap = self.get(name, retry_budget=retry_budget)
        self._core.call(
            snapshots_delete, name, sbx_confirm_delete=snap.id, retry_budget=retry_budget
        )


def _operation_failed(op: Operation) -> SbxError:
    """The error of an operation that did not succeed (failed or superseded)."""
    e = op.error
    code = getattr(e, "code", None)
    message = getattr(e, "message", None)
    retryable = getattr(e, "retryable", None)
    return SbxError(
        status=0,
        code=code if isinstance(code, str) else f"operation_{op.state}",
        message=message
        if isinstance(message, str)
        else f"operation {op.id} ({op.kind}) is {op.state}",
        retryable=retryable if isinstance(retryable, bool) else False,
        details={"operationId": op.id, "kind": str(op.kind), "state": str(op.state)},
    )


class Sbx:
    """Client of the sbx public API.

    Credentials (S7 §7.6): ``api_key`` / ``access_token`` / ``token_provider``
    (called with ``force`` before every request; may be async), else
    SBX_API_KEY, SBX_ACCESS_TOKEN, else ``sbx auth token --json``. The URL is
    ``base_url``, SBX_API_URL or the sbx profile's; the team ``team``,
    SBX_TEAM or the profile's. ``env`` replaces ``os.environ`` (also for the
    ``sbx`` subprocess). ``transport`` is the inner httpx transport (proxies,
    TLS, tests). ``retry_budget`` (default 60 s) and ``stream_idle_timeout``
    (default 45 s) are in seconds.
    """

    def __init__(
        self,
        base_url: str | None = None,
        team: str | None = None,
        api_key: str | None = None,
        access_token: str | None = None,
        token_provider: TokenProvider | None = None,
        *,
        env: Mapping[str, str] | None = None,
        auth_command: Sequence[str] | None = None,
        user_agent: str | None = None,
        retry_budget: float | None = None,
        stream_idle_timeout: float | None = None,
        transport: httpx.BaseTransport | None = None,
        random: Callable[[], float] | None = None,
    ) -> None:
        self._core = ClientCore(
            base_url=base_url,
            team=team,
            api_key=api_key,
            access_token=access_token,
            token_provider=token_provider,
            env=env,
            auth_command=auth_command,
            user_agent=user_agent,
            retry_budget=retry_budget,
            stream_idle_timeout=stream_idle_timeout,
            transport=transport,
            random=random,
        )
        self.sandboxes = Sandboxes(self._core)
        self.snapshots = Snapshots(self._core)

    @property
    def raw(self) -> GenClient:
        """The generated client over this facade's transport:
        ``sandboxes_get.sync("sb_...", client=sbx.raw)``. Only the
        blocking httpx client is set on it, so use the ``sync*`` functions."""
        return self._core.raw

    def __enter__(self) -> Sbx:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._core.close()

    def wait_for_operation(
        self,
        op: str | Operation,
        *,
        timeout: float | None = None,
        retry_budget: float | None = None,
    ) -> Operation:
        """Long-polls an operation (``op_...``) until it is final."""
        return wait_for_operation(self._core, op, timeout=timeout, retry_budget=retry_budget)

    def me(self, *, retry_budget: float | None = None) -> Me:
        return self._core.call(me_get, retry_budget=retry_budget)

    def limits(self, *, retry_budget: float | None = None) -> Limits:
        return self._core.call(limits_get, retry_budget=retry_budget)

    def templates(self, *, retry_budget: float | None = None) -> list[Template]:
        return (self._core.call(templates_list, retry_budget=retry_budget)).data

    def sizes(self, *, retry_budget: float | None = None) -> list[Size]:
        return (self._core.call(sizes_list, retry_budget=retry_budget)).data
