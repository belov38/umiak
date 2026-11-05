from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.meta import Meta
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/meta",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Meta:
    if response.status_code == 200:
        response_200 = Meta.from_dict(response.json())

        return response_200

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | Meta]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | Meta]:
    """Platform information

     Public facts about this deployment: API and dashboard URLs, the domain of published ports, owner
    authentication, the SSH endpoint with its host keys, and CLI versions. Needs no authentication;
    clients call it first to configure themselves.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Meta]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
) -> Error | Meta | None:
    """Platform information

     Public facts about this deployment: API and dashboard URLs, the domain of published ports, owner
    authentication, the SSH endpoint with its host keys, and CLI versions. Needs no authentication;
    clients call it first to configure themselves.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Meta
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | Meta]:
    """Platform information

     Public facts about this deployment: API and dashboard URLs, the domain of published ports, owner
    authentication, the SSH endpoint with its host keys, and CLI versions. Needs no authentication;
    clients call it first to configure themselves.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Meta]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
) -> Error | Meta | None:
    """Platform information

     Public facts about this deployment: API and dashboard URLs, the domain of published ports, owner
    authentication, the SSH endpoint with its host keys, and CLI versions. Needs no authentication;
    clients call it first to configure themselves.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Meta
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
