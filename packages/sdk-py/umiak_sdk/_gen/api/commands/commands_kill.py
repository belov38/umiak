from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.command import Command
from ...models.command_kill_request import CommandKillRequest
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    command: str,
    *,
    body: CommandKillRequest | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/commands/{command}/kill".format(
            sandbox=quote(str(sandbox), safe=""),
            command=quote(str(command), safe=""),
        ),
    }

    if not isinstance(body, Unset):
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

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

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
    command: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommandKillRequest | Unset = UNSET,
) -> Response[Command | Error]:
    """Kill a command

     SIGTERM to the process group, SIGKILL to everything left after `graceMs` (default 10 000).
    Idempotent; an ended command is returned as is.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        body (CommandKillRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommandKillRequest | Unset = UNSET,
) -> Command | Error | None:
    """Kill a command

     SIGTERM to the process group, SIGKILL to everything left after `graceMs` (default 10 000).
    Idempotent; an ended command is returned as is.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        body (CommandKillRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        command=command,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommandKillRequest | Unset = UNSET,
) -> Response[Command | Error]:
    """Kill a command

     SIGTERM to the process group, SIGKILL to everything left after `graceMs` (default 10 000).
    Idempotent; an ended command is returned as is.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        body (CommandKillRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Command | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommandKillRequest | Unset = UNSET,
) -> Command | Error | None:
    """Kill a command

     SIGTERM to the process group, SIGKILL to everything left after `graceMs` (default 10 000).
    Idempotent; an ended command is returned as is.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        body (CommandKillRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Command | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            command=command,
            client=client,
            body=body,
        )
    ).parsed
