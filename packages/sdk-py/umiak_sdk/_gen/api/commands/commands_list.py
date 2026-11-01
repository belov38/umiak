from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.command_list import CommandList
from ...models.commands_list_mode import CommandsListMode
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    status: str | Unset = UNSET,
    mode: CommandsListMode | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["status"] = status

    json_mode: str | Unset = UNSET
    if not isinstance(mode, Unset):
        json_mode = mode.value

    params["mode"] = json_mode

    params["limit"] = limit

    params["cursor"] = cursor

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/commands".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> CommandList | Error:
    if response.status_code == 200:
        response_200 = CommandList.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[CommandList | Error]:
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
    status: str | Unset = UNSET,
    mode: CommandsListMode | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[CommandList | Error]:
    """List commands

     Commands of the sandbox, newest first, kept 90 days; works while the sandbox is stopped. Filters:
    `status` (comma-separated), `mode`.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        status (str | Unset): Comma-separated statuses: starting, running, exited, killed,
            timed_out, lost, failed_to_start Example: running.
        mode (CommandsListMode | Unset):
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandList | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        status=status,
        mode=mode,
        limit=limit,
        cursor=cursor,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    status: str | Unset = UNSET,
    mode: CommandsListMode | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> CommandList | Error | None:
    """List commands

     Commands of the sandbox, newest first, kept 90 days; works while the sandbox is stopped. Filters:
    `status` (comma-separated), `mode`.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        status (str | Unset): Comma-separated statuses: starting, running, exited, killed,
            timed_out, lost, failed_to_start Example: running.
        mode (CommandsListMode | Unset):
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandList | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        status=status,
        mode=mode,
        limit=limit,
        cursor=cursor,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    status: str | Unset = UNSET,
    mode: CommandsListMode | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[CommandList | Error]:
    """List commands

     Commands of the sandbox, newest first, kept 90 days; works while the sandbox is stopped. Filters:
    `status` (comma-separated), `mode`.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        status (str | Unset): Comma-separated statuses: starting, running, exited, killed,
            timed_out, lost, failed_to_start Example: running.
        mode (CommandsListMode | Unset):
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandList | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        status=status,
        mode=mode,
        limit=limit,
        cursor=cursor,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    status: str | Unset = UNSET,
    mode: CommandsListMode | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> CommandList | Error | None:
    """List commands

     Commands of the sandbox, newest first, kept 90 days; works while the sandbox is stopped. Filters:
    `status` (comma-separated), `mode`.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        status (str | Unset): Comma-separated statuses: starting, running, exited, killed,
            timed_out, lost, failed_to_start Example: running.
        mode (CommandsListMode | Unset):
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandList | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            status=status,
            mode=mode,
            limit=limit,
            cursor=cursor,
        )
    ).parsed
