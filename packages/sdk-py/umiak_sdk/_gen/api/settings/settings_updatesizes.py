from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.settings_mutation_result import SettingsMutationResult
from ...models.update_settings_size import UpdateSettingsSize
from ...types import Response


def _get_kwargs(
    slug: str,
    *,
    body: UpdateSettingsSize,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/settings/sizes/{slug}".format(
            slug=quote(str(slug), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SettingsMutationResult:
    if response.status_code == 200:
        response_200 = SettingsMutationResult.from_dict(response.json())

        return response_200

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SettingsMutationResult]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    slug: str,
    *,
    client: AuthenticatedClient,
    body: UpdateSettingsSize,
) -> Response[Error | SettingsMutationResult]:
    """updatesizes

     Owner-only updatesizes. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        slug (str):
        body (UpdateSettingsSize):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsMutationResult]
    """

    kwargs = _get_kwargs(
        slug=slug,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    slug: str,
    *,
    client: AuthenticatedClient,
    body: UpdateSettingsSize,
) -> Error | SettingsMutationResult | None:
    """updatesizes

     Owner-only updatesizes. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        slug (str):
        body (UpdateSettingsSize):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsMutationResult
    """

    return sync_detailed(
        slug=slug,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    slug: str,
    *,
    client: AuthenticatedClient,
    body: UpdateSettingsSize,
) -> Response[Error | SettingsMutationResult]:
    """updatesizes

     Owner-only updatesizes. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        slug (str):
        body (UpdateSettingsSize):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsMutationResult]
    """

    kwargs = _get_kwargs(
        slug=slug,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    slug: str,
    *,
    client: AuthenticatedClient,
    body: UpdateSettingsSize,
) -> Error | SettingsMutationResult | None:
    """updatesizes

     Owner-only updatesizes. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        slug (str):
        body (UpdateSettingsSize):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsMutationResult
    """

    return (
        await asyncio_detailed(
            slug=slug,
            client=client,
            body=body,
        )
    ).parsed
