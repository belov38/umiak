from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.api_key_secret import ApiKeySecret
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    key: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/api-keys/{key}/rotate".format(
            key=quote(str(key), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ApiKeySecret | Error:
    if response.status_code == 200:
        response_200 = ApiKeySecret.from_dict(response.json())

        return response_200

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
) -> Response[ApiKeySecret | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    key: str,
    *,
    client: AuthenticatedClient,
) -> Response[ApiKeySecret | Error]:
    """Rotate a team API key

     Replaces the secret of the key: the old secret stops working at once; id, name, scopes and expiry
    stay. The new secret is in this answer only. Only an owner, as a person.

    Args:
        key (str): API key id (`key_...`) Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ApiKeySecret | Error]
    """

    kwargs = _get_kwargs(
        key=key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    key: str,
    *,
    client: AuthenticatedClient,
) -> ApiKeySecret | Error | None:
    """Rotate a team API key

     Replaces the secret of the key: the old secret stops working at once; id, name, scopes and expiry
    stay. The new secret is in this answer only. Only an owner, as a person.

    Args:
        key (str): API key id (`key_...`) Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ApiKeySecret | Error
    """

    return sync_detailed(
        key=key,
        client=client,
    ).parsed


async def asyncio_detailed(
    key: str,
    *,
    client: AuthenticatedClient,
) -> Response[ApiKeySecret | Error]:
    """Rotate a team API key

     Replaces the secret of the key: the old secret stops working at once; id, name, scopes and expiry
    stay. The new secret is in this answer only. Only an owner, as a person.

    Args:
        key (str): API key id (`key_...`) Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ApiKeySecret | Error]
    """

    kwargs = _get_kwargs(
        key=key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    key: str,
    *,
    client: AuthenticatedClient,
) -> ApiKeySecret | Error | None:
    """Rotate a team API key

     Replaces the secret of the key: the old secret stops working at once; id, name, scopes and expiry
    stay. The new secret is in this answer only. Only an owner, as a person.

    Args:
        key (str): API key id (`key_...`) Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ApiKeySecret | Error
    """

    return (
        await asyncio_detailed(
            key=key,
            client=client,
        )
    ).parsed
