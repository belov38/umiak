from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.create_settings_team import CreateSettingsTeam
from ...models.error import Error
from ...models.settings_team import SettingsTeam
from ...types import Response


def _get_kwargs(
    *,
    body: CreateSettingsTeam,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/settings/teams",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SettingsTeam:
    if response.status_code == 200:
        response_200 = SettingsTeam.from_dict(response.json())

        return response_200

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SettingsTeam]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateSettingsTeam,
) -> Response[Error | SettingsTeam]:
    """createTeam

     Owner-only createTeam. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (CreateSettingsTeam):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsTeam]
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
    body: CreateSettingsTeam,
) -> Error | SettingsTeam | None:
    """createTeam

     Owner-only createTeam. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (CreateSettingsTeam):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsTeam
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateSettingsTeam,
) -> Response[Error | SettingsTeam]:
    """createTeam

     Owner-only createTeam. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (CreateSettingsTeam):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SettingsTeam]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CreateSettingsTeam,
) -> Error | SettingsTeam | None:
    """createTeam

     Owner-only createTeam. Requires a browser or paired owner session; scoped team keys are refused.

    Args:
        body (CreateSettingsTeam):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SettingsTeam
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
