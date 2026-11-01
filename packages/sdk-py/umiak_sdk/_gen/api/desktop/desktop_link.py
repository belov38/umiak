from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.desktop_link_body import DesktopLinkBody
from ...models.desktop_link_response_201 import DesktopLinkResponse201
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: DesktopLinkBody | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/desktop/links".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> DesktopLinkResponse201 | Error:
    if response.status_code == 201:
        response_201 = DesktopLinkResponse201.from_dict(response.json())

        return response_201

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[DesktopLinkResponse201 | Error]:
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
    body: DesktopLinkBody | Unset = UNSET,
) -> Response[DesktopLinkResponse201 | Error]:
    """Desktop link

     link for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopLinkBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DesktopLinkResponse201 | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopLinkBody | Unset = UNSET,
) -> DesktopLinkResponse201 | Error | None:
    """Desktop link

     link for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopLinkBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DesktopLinkResponse201 | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopLinkBody | Unset = UNSET,
) -> Response[DesktopLinkResponse201 | Error]:
    """Desktop link

     link for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopLinkBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DesktopLinkResponse201 | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopLinkBody | Unset = UNSET,
) -> DesktopLinkResponse201 | Error | None:
    """Desktop link

     link for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopLinkBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DesktopLinkResponse201 | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
