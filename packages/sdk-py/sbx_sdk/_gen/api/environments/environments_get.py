from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.environment import Environment
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    environment: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/environments/{environment}".format(
            environment=quote(str(environment), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Environment | Error:
    if response.status_code == 200:
        response_200 = Environment.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Environment | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Environment | Error]:
    """Get an environment

     The environment with its env values. Secret values are never returned, only their names.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Environment | Error]
    """

    kwargs = _get_kwargs(
        environment=environment,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
) -> Environment | Error | None:
    """Get an environment

     The environment with its env values. Secret values are never returned, only their names.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Environment | Error
    """

    return sync_detailed(
        environment=environment,
        client=client,
    ).parsed


async def asyncio_detailed(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Environment | Error]:
    """Get an environment

     The environment with its env values. Secret values are never returned, only their names.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Environment | Error]
    """

    kwargs = _get_kwargs(
        environment=environment,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
) -> Environment | Error | None:
    """Get an environment

     The environment with its env values. Secret values are never returned, only their names.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Environment | Error
    """

    return (
        await asyncio_detailed(
            environment=environment,
            client=client,
        )
    ).parsed
