from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.command import Command
from ...models.create_pty_request import CreatePtyRequest
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: CreatePtyRequest,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/ptys".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Command | Error:
    if response.status_code == 200:
        response_200 = Command.from_dict(response.json())

        return response_200

    if response.status_code == 201:
        response_201 = Command.from_dict(response.json())

        return response_201

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Command | Error]:
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
    body: CreatePtyRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Command | Error]:
    """Open a terminal

     Starts a PTY command in a ready sandbox (a creating or starting one is awaited up to 60 s): the
    user's login shell, or `command` run by `bash -lc` in the terminal. Answers 201 Command (mode `pty`,
    one output stream `pty`). Connect with GET .../connect (WebSocket), or read it with GET
    .../commands/{command}/stream?ptyOffset= and write with POST .../commands/{command}/input. A PTY
    with no client connected is closed by the agent after 10 min (reason pty_idle). With an Idempotency-
    Key a repeat returns the same command with 200 and `Idempotency-Replayed: true`. Needs the agent
    capability process.pty.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the same PTY instead of starting another one (24 h)
        body (CreatePtyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Error]
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
    body: CreatePtyRequest,
    idempotency_key: str | Unset = UNSET,
) -> Command | Error | None:
    """Open a terminal

     Starts a PTY command in a ready sandbox (a creating or starting one is awaited up to 60 s): the
    user's login shell, or `command` run by `bash -lc` in the terminal. Answers 201 Command (mode `pty`,
    one output stream `pty`). Connect with GET .../connect (WebSocket), or read it with GET
    .../commands/{command}/stream?ptyOffset= and write with POST .../commands/{command}/input. A PTY
    with no client connected is closed by the agent after 10 min (reason pty_idle). With an Idempotency-
    Key a repeat returns the same command with 200 and `Idempotency-Replayed: true`. Needs the agent
    capability process.pty.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the same PTY instead of starting another one (24 h)
        body (CreatePtyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Error
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
    body: CreatePtyRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Command | Error]:
    """Open a terminal

     Starts a PTY command in a ready sandbox (a creating or starting one is awaited up to 60 s): the
    user's login shell, or `command` run by `bash -lc` in the terminal. Answers 201 Command (mode `pty`,
    one output stream `pty`). Connect with GET .../connect (WebSocket), or read it with GET
    .../commands/{command}/stream?ptyOffset= and write with POST .../commands/{command}/input. A PTY
    with no client connected is closed by the agent after 10 min (reason pty_idle). With an Idempotency-
    Key a repeat returns the same command with 200 and `Idempotency-Replayed: true`. Needs the agent
    capability process.pty.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the same PTY instead of starting another one (24 h)
        body (CreatePtyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Error]
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
    body: CreatePtyRequest,
    idempotency_key: str | Unset = UNSET,
) -> Command | Error | None:
    """Open a terminal

     Starts a PTY command in a ready sandbox (a creating or starting one is awaited up to 60 s): the
    user's login shell, or `command` run by `bash -lc` in the terminal. Answers 201 Command (mode `pty`,
    one output stream `pty`). Connect with GET .../connect (WebSocket), or read it with GET
    .../commands/{command}/stream?ptyOffset= and write with POST .../commands/{command}/input. A PTY
    with no client connected is closed by the agent after 10 min (reason pty_idle). With an Idempotency-
    Key a repeat returns the same command with 200 and `Idempotency-Replayed: true`. Needs the agent
    capability process.pty.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the same PTY instead of starting another one (24 h)
        body (CreatePtyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
