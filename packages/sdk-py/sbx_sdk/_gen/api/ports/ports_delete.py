from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    sandbox: str,
    port: int,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/sandboxes/{sandbox}/ports/{port}".format(
            sandbox=quote(str(sandbox), safe=""),
            port=quote(str(port), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

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
) -> Response[Any | Error]:
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
) -> Response[Any | Error]:
    """Unpublish a port

     Stops publishing the port; its links and cookies stop working. Repeating is safe: a port that is not
    hosted also answers 204.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
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
) -> Any | Error | None:
    """Unpublish a port

     Stops publishing the port; its links and cookies stop working. Repeating is safe: a port that is not
    hosted also answers 204.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
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
) -> Response[Any | Error]:
    """Unpublish a port

     Stops publishing the port; its links and cookies stop working. Repeating is safe: a port that is not
    hosted also answers 204.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
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
) -> Any | Error | None:
    """Unpublish a port

     Stops publishing the port; its links and cookies stop working. Repeating is safe: a port that is not
    hosted also answers 204.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            port=port,
            client=client,
        )
    ).parsed
