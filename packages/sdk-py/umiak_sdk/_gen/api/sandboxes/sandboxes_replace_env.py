from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.env_replace_request import EnvReplaceRequest
from ...models.error import Error
from ...models.sandbox_env_update import SandboxEnvUpdate
from ...types import Response


def _get_kwargs(
    sandbox: str,
    *,
    body: EnvReplaceRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/env".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxEnvUpdate:
    if response.status_code == 200:
        response_200 = SandboxEnvUpdate.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

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
) -> Response[Error | SandboxEnvUpdate]:
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
    body: EnvReplaceRequest,
) -> Response[Error | SandboxEnvUpdate]:
    """Replace env and secrets

     Each given set (env, secrets, secretFiles) replaces that set whole; the others stay. New commands
    see the new values, running ones do not. `delivered: false` means the sandbox is not ready or its
    agent is unreachable: the sets apply at the next resume.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (EnvReplaceRequest): Each given set replaces its set whole; the others stay

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxEnvUpdate]
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
    body: EnvReplaceRequest,
) -> Error | SandboxEnvUpdate | None:
    """Replace env and secrets

     Each given set (env, secrets, secretFiles) replaces that set whole; the others stay. New commands
    see the new values, running ones do not. `delivered: false` means the sandbox is not ready or its
    agent is unreachable: the sets apply at the next resume.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (EnvReplaceRequest): Each given set replaces its set whole; the others stay

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxEnvUpdate
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
    body: EnvReplaceRequest,
) -> Response[Error | SandboxEnvUpdate]:
    """Replace env and secrets

     Each given set (env, secrets, secretFiles) replaces that set whole; the others stay. New commands
    see the new values, running ones do not. `delivered: false` means the sandbox is not ready or its
    agent is unreachable: the sets apply at the next resume.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (EnvReplaceRequest): Each given set replaces its set whole; the others stay

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxEnvUpdate]
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
    body: EnvReplaceRequest,
) -> Error | SandboxEnvUpdate | None:
    """Replace env and secrets

     Each given set (env, secrets, secretFiles) replaces that set whole; the others stay. New commands
    see the new values, running ones do not. `delivered: false` means the sandbox is not ready or its
    agent is unreachable: the sets apply at the next resume.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (EnvReplaceRequest): Each given set replaces its set whole; the others stay

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxEnvUpdate
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
