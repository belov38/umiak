from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.command import Command
from ...models.error import Error
from ...models.start_command_request import StartCommandRequest
from ...models.sync_command_result import SyncCommandResult
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: StartCommandRequest,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/commands".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Command | Command | SyncCommandResult | Error:
    if response.status_code == 200:

        def _parse_response_200(data: object) -> Command | SyncCommandResult:
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_0 = SyncCommandResult.from_dict(data)

                return response_200_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            response_200_type_1 = Command.from_dict(data)

            return response_200_type_1

        response_200 = _parse_response_200(response.json())

        return response_200

    if response.status_code == 201:
        response_201 = Command.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Command | Command | SyncCommandResult | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: StartCommandRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Command | Command | SyncCommandResult | Error]:
    """Run a command

     Starts a process in a ready sandbox (a creating or starting one is awaited up to 60 s). Exactly one
    of `command` (bash -lc) and `argv`. Modes: `sync` (default) answers 200 SyncCommandResult once the
    process exits (timeout at most 600 s; the connection is silent until then, so proxies may cut it:
    SDKs use stream); `stream` answers 200 application/x-ndjson frames (first `started`, last `exit`,
    `reconnect` or `error`) with `Sbx-Command-Id`; `detached` answers 201 Command right after the start.
    With an Idempotency-Key a repeat never starts the command twice: sync waits for the same command,
    stream streams it from offset 0 with `started.replayed: true`, detached answers 200.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body attaches to the same command instead of starting it again (24 h)
        body (StartCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Command | SyncCommandResult | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: StartCommandRequest,
    idempotency_key: str | Unset = UNSET,
) -> Command | Command | SyncCommandResult | Error | None:
    """Run a command

     Starts a process in a ready sandbox (a creating or starting one is awaited up to 60 s). Exactly one
    of `command` (bash -lc) and `argv`. Modes: `sync` (default) answers 200 SyncCommandResult once the
    process exits (timeout at most 600 s; the connection is silent until then, so proxies may cut it:
    SDKs use stream); `stream` answers 200 application/x-ndjson frames (first `started`, last `exit`,
    `reconnect` or `error`) with `Sbx-Command-Id`; `detached` answers 201 Command right after the start.
    With an Idempotency-Key a repeat never starts the command twice: sync waits for the same command,
    stream streams it from offset 0 with `started.replayed: true`, detached answers 200.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body attaches to the same command instead of starting it again (24 h)
        body (StartCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Command | SyncCommandResult | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: StartCommandRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Command | Command | SyncCommandResult | Error]:
    """Run a command

     Starts a process in a ready sandbox (a creating or starting one is awaited up to 60 s). Exactly one
    of `command` (bash -lc) and `argv`. Modes: `sync` (default) answers 200 SyncCommandResult once the
    process exits (timeout at most 600 s; the connection is silent until then, so proxies may cut it:
    SDKs use stream); `stream` answers 200 application/x-ndjson frames (first `started`, last `exit`,
    `reconnect` or `error`) with `Sbx-Command-Id`; `detached` answers 201 Command right after the start.
    With an Idempotency-Key a repeat never starts the command twice: sync waits for the same command,
    stream streams it from offset 0 with `started.replayed: true`, detached answers 200.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body attaches to the same command instead of starting it again (24 h)
        body (StartCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Command | SyncCommandResult | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: StartCommandRequest,
    idempotency_key: str | Unset = UNSET,
) -> Command | Command | SyncCommandResult | Error | None:
    """Run a command

     Starts a process in a ready sandbox (a creating or starting one is awaited up to 60 s). Exactly one
    of `command` (bash -lc) and `argv`. Modes: `sync` (default) answers 200 SyncCommandResult once the
    process exits (timeout at most 600 s; the connection is silent until then, so proxies may cut it:
    SDKs use stream); `stream` answers 200 application/x-ndjson frames (first `started`, last `exit`,
    `reconnect` or `error`) with `Sbx-Command-Id`; `detached` answers 201 Command right after the start.
    With an Idempotency-Key a repeat never starts the command twice: sync waits for the same command,
    stream streams it from offset 0 with `started.replayed: true`, detached answers 200.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body attaches to the same command instead of starting it again (24 h)
        body (StartCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Command | SyncCommandResult | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
