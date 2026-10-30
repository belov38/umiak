from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.meta_openapi_response_200 import MetaOpenapiResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/openapi.json",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | MetaOpenapiResponse200:
    if response.status_code == 200:
        response_200 = MetaOpenapiResponse200.from_dict(response.json())

        return response_200

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | MetaOpenapiResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | MetaOpenapiResponse200]:
    """OpenAPI document

     This OpenAPI 3.1 document, with the server URL and Keycloak issuer of this deployment. Needs no
    authentication. SDKs are generated from it.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | MetaOpenapiResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
) -> Error | MetaOpenapiResponse200 | None:
    """OpenAPI document

     This OpenAPI 3.1 document, with the server URL and Keycloak issuer of this deployment. Needs no
    authentication. SDKs are generated from it.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | MetaOpenapiResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | MetaOpenapiResponse200]:
    """OpenAPI document

     This OpenAPI 3.1 document, with the server URL and Keycloak issuer of this deployment. Needs no
    authentication. SDKs are generated from it.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | MetaOpenapiResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
) -> Error | MetaOpenapiResponse200 | None:
    """OpenAPI document

     This OpenAPI 3.1 document, with the server URL and Keycloak issuer of this deployment. Needs no
    authentication. SDKs are generated from it.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | MetaOpenapiResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
