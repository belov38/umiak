from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.api_key_secret import ApiKeySecret
from ...models.create_api_key_request import CreateApiKeyRequest
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    *,
    body: CreateApiKeyRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/api-keys",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ApiKeySecret | Error:
    if response.status_code == 201:
        response_201 = ApiKeySecret.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ApiKeySecret | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateApiKeyRequest,
) -> Response[ApiKeySecret | Error]:
    """Issue a team API key

     Issues a key of the team for automation and CI with `scopes` or a `preset` (read-only, ci, full) and
    a lifetime (default 90 days, at most 365). The secret is in this answer only. Only an owner of the
    team, as a person (dashboard or `umiak login`); a key cannot issue keys. People use `umiak login`
    instead of keys.

    Args:
        body (CreateApiKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ApiKeySecret | Error]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: CreateApiKeyRequest,
) -> ApiKeySecret | Error | None:
    """Issue a team API key

     Issues a key of the team for automation and CI with `scopes` or a `preset` (read-only, ci, full) and
    a lifetime (default 90 days, at most 365). The secret is in this answer only. Only an owner of the
    team, as a person (dashboard or `umiak login`); a key cannot issue keys. People use `umiak login`
    instead of keys.

    Args:
        body (CreateApiKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ApiKeySecret | Error
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateApiKeyRequest,
) -> Response[ApiKeySecret | Error]:
    """Issue a team API key

     Issues a key of the team for automation and CI with `scopes` or a `preset` (read-only, ci, full) and
    a lifetime (default 90 days, at most 365). The secret is in this answer only. Only an owner of the
    team, as a person (dashboard or `umiak login`); a key cannot issue keys. People use `umiak login`
    instead of keys.

    Args:
        body (CreateApiKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ApiKeySecret | Error]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CreateApiKeyRequest,
) -> ApiKeySecret | Error | None:
    """Issue a team API key

     Issues a key of the team for automation and CI with `scopes` or a `preset` (read-only, ci, full) and
    a lifetime (default 90 days, at most 365). The secret is in this answer only. Only an owner of the
    team, as a person (dashboard or `umiak login`); a key cannot issue keys. People use `umiak login`
    instead of keys.

    Args:
        body (CreateApiKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ApiKeySecret | Error
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
