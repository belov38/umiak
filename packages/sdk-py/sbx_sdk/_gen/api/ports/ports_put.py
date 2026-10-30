from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.host_port_request import HostPortRequest
from ...models.hosted_port_write import HostedPortWrite
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    port: int,
    *,
    body: HostPortRequest | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/ports/{port}".format(
            sandbox=quote(str(sandbox), safe=""),
            port=quote(str(port), safe=""),
        ),
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | HostedPortWrite:
    if response.status_code == 200:
        response_200 = HostedPortWrite.from_dict(response.json())

        return response_200

    if response.status_code == 201:
        response_201 = HostedPortWrite.from_dict(response.json())

        return response_201

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
) -> Response[Error | HostedPortWrite]:
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
    body: HostPortRequest | Unset = UNSET,
) -> Response[Error | HostedPortWrite]:
    """Publish a port or change its access

     Publishes the guest port at `https://<slug>-<port>.<sbxDomain>` with the given settings (PUT:
    omitted fields take their defaults: access token, hostRewrite preserve, appProtocol http1). 201 for
    a new port, 200 for a change or the same settings. A new token port or a switch to token returns
    `token` and `urlWithToken` once; keep them. Any access change invalidates the port's links and
    cookies. Allowed in any state but deleting and deleted.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (HostPortRequest | Unset): The full desired settings (PUT): an omitted field takes
            its default, not the current value

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | HostedPortWrite]
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
    body: HostPortRequest | Unset = UNSET,
) -> Error | HostedPortWrite | None:
    """Publish a port or change its access

     Publishes the guest port at `https://<slug>-<port>.<sbxDomain>` with the given settings (PUT:
    omitted fields take their defaults: access token, hostRewrite preserve, appProtocol http1). 201 for
    a new port, 200 for a change or the same settings. A new token port or a switch to token returns
    `token` and `urlWithToken` once; keep them. Any access change invalidates the port's links and
    cookies. Allowed in any state but deleting and deleted.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (HostPortRequest | Unset): The full desired settings (PUT): an omitted field takes
            its default, not the current value

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | HostedPortWrite
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
    body: HostPortRequest | Unset = UNSET,
) -> Response[Error | HostedPortWrite]:
    """Publish a port or change its access

     Publishes the guest port at `https://<slug>-<port>.<sbxDomain>` with the given settings (PUT:
    omitted fields take their defaults: access token, hostRewrite preserve, appProtocol http1). 201 for
    a new port, 200 for a change or the same settings. A new token port or a switch to token returns
    `token` and `urlWithToken` once; keep them. Any access change invalidates the port's links and
    cookies. Allowed in any state but deleting and deleted.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (HostPortRequest | Unset): The full desired settings (PUT): an omitted field takes
            its default, not the current value

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | HostedPortWrite]
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
    body: HostPortRequest | Unset = UNSET,
) -> Error | HostedPortWrite | None:
    """Publish a port or change its access

     Publishes the guest port at `https://<slug>-<port>.<sbxDomain>` with the given settings (PUT:
    omitted fields take their defaults: access token, hostRewrite preserve, appProtocol http1). 201 for
    a new port, 200 for a change or the same settings. A new token port or a switch to token returns
    `token` and `urlWithToken` once; keep them. Any access change invalidates the port's links and
    cookies. Allowed in any state but deleting and deleted.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        port (int): TCP port in the guest, 1-65535; not 22, 47800, 47984, 47989, 47990, 48010
            (platform) Example: 3000.
        body (HostPortRequest | Unset): The full desired settings (PUT): an omitted field takes
            its default, not the current value

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | HostedPortWrite
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            port=port,
            client=client,
            body=body,
        )
    ).parsed
