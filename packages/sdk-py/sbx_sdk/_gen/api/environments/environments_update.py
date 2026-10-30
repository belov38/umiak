from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.environment import Environment
from ...models.error import Error
from ...models.update_environment_request import UpdateEnvironmentRequest
from ...types import Response


def _get_kwargs(
    environment: str,
    *,
    body: UpdateEnvironmentRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/environments/{environment}".format(
            environment=quote(str(environment), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Environment | Error:
    if response.status_code == 200:
        response_200 = Environment.from_dict(response.json())

        return response_200

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
    body: UpdateEnvironmentRequest,
) -> Response[Environment | Error]:
    """Change an environment

     Sets merge by key: a value sets the variable, null deletes it; secret files by name (null deletes).
    `repositories` replaces the list. `revision` grows by one. Sandboxes created before keep their
    values.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.
        body (UpdateEnvironmentRequest): Sets merge by key (null deletes a key or a file);
            repositories are replaced; revision + 1

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Environment | Error]
    """

    kwargs = _get_kwargs(
        environment=environment,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
    body: UpdateEnvironmentRequest,
) -> Environment | Error | None:
    """Change an environment

     Sets merge by key: a value sets the variable, null deletes it; secret files by name (null deletes).
    `repositories` replaces the list. `revision` grows by one. Sandboxes created before keep their
    values.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.
        body (UpdateEnvironmentRequest): Sets merge by key (null deletes a key or a file);
            repositories are replaced; revision + 1

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Environment | Error
    """

    return sync_detailed(
        environment=environment,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
    body: UpdateEnvironmentRequest,
) -> Response[Environment | Error]:
    """Change an environment

     Sets merge by key: a value sets the variable, null deletes it; secret files by name (null deletes).
    `repositories` replaces the list. `revision` grows by one. Sandboxes created before keep their
    values.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.
        body (UpdateEnvironmentRequest): Sets merge by key (null deletes a key or a file);
            repositories are replaced; revision + 1

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Environment | Error]
    """

    kwargs = _get_kwargs(
        environment=environment,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    environment: str,
    *,
    client: AuthenticatedClient | Client,
    body: UpdateEnvironmentRequest,
) -> Environment | Error | None:
    """Change an environment

     Sets merge by key: a value sets the variable, null deletes it; secret files by name (null deletes).
    `repositories` replaces the list. `revision` grows by one. Sandboxes created before keep their
    values.

    Args:
        environment (str): Environment id (`env_...`) or name Example: production.
        body (UpdateEnvironmentRequest): Sets merge by key (null deletes a key or a file);
            repositories are replaced; revision + 1

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
            body=body,
        )
    ).parsed
