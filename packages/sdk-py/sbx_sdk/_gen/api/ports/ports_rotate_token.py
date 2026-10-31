from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.port_token import PortToken
from ...types import Response


def _get_kwargs(
    sandbox: str,
    port: int,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/ports/{port}/rotate-token".format(
            sandbox=quote(str(sandbox), safe=""),
            port=quote(str(port), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | PortToken:
    if response.status_code == 200:
        response_200 = PortToken.from_dict(response.json())

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

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | PortToken]:
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
) -> Response[Error | PortToken]:
    """Issue a new port token

     Replaces the token of a token port: the old token, its links and cookies stop working at once. The
    new token is returned only here.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | PortToken]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        port=port,
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
) -> Error | PortToken | None:
    """Issue a new port token

     Replaces the token of a token port: the old token, its links and cookies stop working at once. The
    new token is returned only here.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | PortToken
    """

    return sync_detailed(
        sandbox=sandbox,
        port=port,
        client=client,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | PortToken]:
    """Issue a new port token

     Replaces the token of a token port: the old token, its links and cookies stop working at once. The
    new token is returned only here.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | PortToken]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        port=port,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
) -> Error | PortToken | None:
    """Issue a new port token

     Replaces the token of a token port: the old token, its links and cookies stop working at once. The
    new token is returned only here.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | PortToken
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            port=port,
            client=client,
        )
    ).parsed
