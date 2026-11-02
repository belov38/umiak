from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.desktop_status_response_200 import DesktopStatusResponse200
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    sandbox: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/desktop".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DesktopStatusResponse200 | Error:
    if response.status_code == 200:
        response_200 = DesktopStatusResponse200.from_dict(response.json())

        return response_200

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[DesktopStatusResponse200 | Error]:
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
) -> Response[DesktopStatusResponse200 | Error]:
    """Desktop status

     status for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DesktopStatusResponse200 | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> DesktopStatusResponse200 | Error | None:
    """Desktop status

     status for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DesktopStatusResponse200 | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[DesktopStatusResponse200 | Error]:
    """Desktop status

     status for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DesktopStatusResponse200 | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> DesktopStatusResponse200 | Error | None:
    """Desktop status

     status for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DesktopStatusResponse200 | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
        )
    ).parsed
