from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.create_ssh_key_request import CreateSshKeyRequest
from ...models.error import Error
from ...models.ssh_key import SshKey
from ...types import Response


def _get_kwargs(
    *,
    body: CreateSshKeyRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/ssh-keys",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SshKey:
    if response.status_code == 201:
        response_201 = SshKey.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SshKey]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateSshKeyRequest,
) -> Response[Error | SshKey]:
    """Add an SSH key

     Registers a public key of the calling person for `ssh <sandbox>@<ssh host>`. Types: ssh-ed25519,
    ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no certificates. A key can belong to one
    person on the platform only.

    Args:
        body (CreateSshKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SshKey]
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
    body: CreateSshKeyRequest,
) -> Error | SshKey | None:
    """Add an SSH key

     Registers a public key of the calling person for `ssh <sandbox>@<ssh host>`. Types: ssh-ed25519,
    ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no certificates. A key can belong to one
    person on the platform only.

    Args:
        body (CreateSshKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SshKey
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CreateSshKeyRequest,
) -> Response[Error | SshKey]:
    """Add an SSH key

     Registers a public key of the calling person for `ssh <sandbox>@<ssh host>`. Types: ssh-ed25519,
    ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no certificates. A key can belong to one
    person on the platform only.

    Args:
        body (CreateSshKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SshKey]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CreateSshKeyRequest,
) -> Error | SshKey | None:
    """Add an SSH key

     Registers a public key of the calling person for `ssh <sandbox>@<ssh host>`. Types: ssh-ed25519,
    ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no certificates. A key can belong to one
    person on the platform only.

    Args:
        body (CreateSshKeyRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SshKey
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
