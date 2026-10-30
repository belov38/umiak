from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox import Sandbox
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    wait_for: str | Unset = UNSET,
    wait_seconds: int | None | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["waitFor"] = wait_for

    json_wait_seconds: int | None | Unset
    if isinstance(wait_seconds, Unset):
        json_wait_seconds = UNSET
    else:
        json_wait_seconds = wait_seconds
    params["waitSeconds"] = json_wait_seconds

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Sandbox:
    if response.status_code == 200:
        response_200 = Sandbox.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | Sandbox]:
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
    wait_for: str | Unset = UNSET,
    wait_seconds: int | None | Unset = UNSET,
) -> Response[Error | Sandbox]:
    """Get a sandbox (long-poll)

     The sandbox by id or slug. With `waitFor=ready,stopped` (and `waitSeconds`, up to 60, default 30)
    the answer comes as soon as the state is one of them or becomes error/deleting/deleted, else after
    the timeout with the current state; 200 either way. Deleted sandboxes stay readable for 30 days.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        wait_for (str | Unset): Long-poll: comma-separated states; answers once the state is one
            of them or error/deleting/deleted, else after waitSeconds Example: ready.
        wait_seconds (int | None | Unset): Long-poll timeout, 0-60 seconds (default 30 with
            waitFor)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        wait_for=wait_for,
        wait_seconds=wait_seconds,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    wait_for: str | Unset = UNSET,
    wait_seconds: int | None | Unset = UNSET,
) -> Error | Sandbox | None:
    """Get a sandbox (long-poll)

     The sandbox by id or slug. With `waitFor=ready,stopped` (and `waitSeconds`, up to 60, default 30)
    the answer comes as soon as the state is one of them or becomes error/deleting/deleted, else after
    the timeout with the current state; 200 either way. Deleted sandboxes stay readable for 30 days.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        wait_for (str | Unset): Long-poll: comma-separated states; answers once the state is one
            of them or error/deleting/deleted, else after waitSeconds Example: ready.
        wait_seconds (int | None | Unset): Long-poll timeout, 0-60 seconds (default 30 with
            waitFor)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        wait_for=wait_for,
        wait_seconds=wait_seconds,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    wait_for: str | Unset = UNSET,
    wait_seconds: int | None | Unset = UNSET,
) -> Response[Error | Sandbox]:
    """Get a sandbox (long-poll)

     The sandbox by id or slug. With `waitFor=ready,stopped` (and `waitSeconds`, up to 60, default 30)
    the answer comes as soon as the state is one of them or becomes error/deleting/deleted, else after
    the timeout with the current state; 200 either way. Deleted sandboxes stay readable for 30 days.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        wait_for (str | Unset): Long-poll: comma-separated states; answers once the state is one
            of them or error/deleting/deleted, else after waitSeconds Example: ready.
        wait_seconds (int | None | Unset): Long-poll timeout, 0-60 seconds (default 30 with
            waitFor)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        wait_for=wait_for,
        wait_seconds=wait_seconds,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    wait_for: str | Unset = UNSET,
    wait_seconds: int | None | Unset = UNSET,
) -> Error | Sandbox | None:
    """Get a sandbox (long-poll)

     The sandbox by id or slug. With `waitFor=ready,stopped` (and `waitSeconds`, up to 60, default 30)
    the answer comes as soon as the state is one of them or becomes error/deleting/deleted, else after
    the timeout with the current state; 200 either way. Deleted sandboxes stay readable for 30 days.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        wait_for (str | Unset): Long-poll: comma-separated states; answers once the state is one
            of them or error/deleting/deleted, else after waitSeconds Example: ready.
        wait_seconds (int | None | Unset): Long-poll timeout, 0-60 seconds (default 30 with
            waitFor)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            wait_for=wait_for,
            wait_seconds=wait_seconds,
        )
    ).parsed
