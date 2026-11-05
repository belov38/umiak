from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.settings_mutation_result import SettingsMutationResult
from ...models.settings_update_account_body import SettingsUpdateAccountBody
from ...types import Response


def _get_kwargs(
    *,
    body: SettingsUpdateAccountBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/settings/account",
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
    *,
    client: AuthenticatedClient,
    body: SettingsUpdateAccountBody,
) -> Response[Error | SettingsMutationResult]:
    """updateAccount

     Owner-only updateAccount. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (SettingsUpdateAccountBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsMutationResult]
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
    body: SettingsUpdateAccountBody,
) -> Error | SettingsMutationResult | None:
    """updateAccount

     Owner-only updateAccount. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (SettingsUpdateAccountBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsMutationResult
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: SettingsUpdateAccountBody,
) -> Response[Error | SettingsMutationResult]:
    """updateAccount

     Owner-only updateAccount. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (SettingsUpdateAccountBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsMutationResult]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: SettingsUpdateAccountBody,
) -> Error | SettingsMutationResult | None:
    """updateAccount

     Owner-only updateAccount. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (SettingsUpdateAccountBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsMutationResult
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
