from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.block_request import BlockRequest
from ...models.error import Error
from ...models.hosted_port import HostedPort
from ...types import Response


def _get_kwargs(
    sandbox: str,
    port: int,
    *,
    body: BlockRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/ports/{port}/block".format(
            sandbox=quote(str(sandbox), safe=""),
            port=quote(str(port), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | HostedPort:
    if response.status_code == 200:
        response_200 = HostedPort.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | HostedPort]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: BlockRequest,
) -> Response[Error | HostedPort]:
    """Block a hosted port (operator)

     Blocks the port: the gateway refuses it, and for everyone but an operator PUT, rotate-token and
    DELETE of the port are 403 `forbidden` (details.reason `port_blocked`), so the block survives an
    unpublish and a new publish. The same reason again changes nothing. Only a platform operator's
    browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden` (details.reason
    `operator_required`). The sandbox is found in any team, no Umiak-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (BlockRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | HostedPort]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        port=port,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: BlockRequest,
) -> Error | HostedPort | None:
    """Block a hosted port (operator)

     Blocks the port: the gateway refuses it, and for everyone but an operator PUT, rotate-token and
    DELETE of the port are 403 `forbidden` (details.reason `port_blocked`), so the block survives an
    unpublish and a new publish. The same reason again changes nothing. Only a platform operator's
    browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden` (details.reason
    `operator_required`). The sandbox is found in any team, no Umiak-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (BlockRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | HostedPort
    """

    return sync_detailed(
        sandbox=sandbox,
        port=port,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: BlockRequest,
) -> Response[Error | HostedPort]:
    """Block a hosted port (operator)

     Blocks the port: the gateway refuses it, and for everyone but an operator PUT, rotate-token and
    DELETE of the port are 403 `forbidden` (details.reason `port_blocked`), so the block survives an
    unpublish and a new publish. The same reason again changes nothing. Only a platform operator's
    browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden` (details.reason
    `operator_required`). The sandbox is found in any team, no Umiak-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (BlockRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | HostedPort]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        port=port,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: BlockRequest,
) -> Error | HostedPort | None:
    """Block a hosted port (operator)

     Blocks the port: the gateway refuses it, and for everyone but an operator PUT, rotate-token and
    DELETE of the port are 403 `forbidden` (details.reason `port_blocked`), so the block survives an
    unpublish and a new publish. The same reason again changes nothing. Only a platform operator's
    browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden` (details.reason
    `operator_required`). The sandbox is found in any team, no Umiak-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (BlockRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | HostedPort
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            port=port,
            client=client,
            body=body,
        )
    ).parsed
