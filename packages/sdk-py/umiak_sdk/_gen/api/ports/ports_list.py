from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox_ports import SandboxPorts
from ...types import Response


def _get_kwargs(
    sandbox: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/ports".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxPorts:
    if response.status_code == 200:
        response_200 = SandboxPorts.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxPorts]:
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
) -> Response[Error | SandboxPorts]:
    """List hosted and listening ports

     `hosted`: ports published through the gateway, with their URLs (tokens are never shown again).
    `listening`: TCP ports processes in the guest listen on, live from the agent when the sandbox is
    ready, else the last report.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxPorts]
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
) -> Error | SandboxPorts | None:
    """List hosted and listening ports

     `hosted`: ports published through the gateway, with their URLs (tokens are never shown again).
    `listening`: TCP ports processes in the guest listen on, live from the agent when the sandbox is
    ready, else the last report.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxPorts
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | SandboxPorts]:
    """List hosted and listening ports

     `hosted`: ports published through the gateway, with their URLs (tokens are never shown again).
    `listening`: TCP ports processes in the guest listen on, live from the agent when the sandbox is
    ready, else the last report.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxPorts]
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
) -> Error | SandboxPorts | None:
    """List hosted and listening ports

     `hosted`: ports published through the gateway, with their URLs (tokens are never shown again).
    `listening`: TCP ports processes in the guest listen on, live from the agent when the sandbox is
    ready, else the last report.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxPorts
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
        )
    ).parsed
