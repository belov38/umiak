from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox import Sandbox
from ...models.update_sandbox_request import UpdateSandboxRequest
from ...types import Response


def _get_kwargs(
    sandbox: str,
    *,
    body: UpdateSandboxRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/sandboxes/{sandbox}".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Sandbox:
    if response.status_code == 200:
        response_200 = Sandbox.from_dict(response.json())

        return response_200

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
) -> Response[Error | Sandbox]:
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
    body: UpdateSandboxRequest,
) -> Response[Error | Sandbox]:
    """Update a sandbox

     Changes name, slug, labels (replaced whole), ttlSeconds (deadline = now + ttl on a ready sandbox;
    null removes it) and idleTimeoutSeconds. A new slug changes the URLs of published ports at once; old
    URLs and cookies stop working.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UpdateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: UpdateSandboxRequest,
) -> Error | Sandbox | None:
    """Update a sandbox

     Changes name, slug, labels (replaced whole), ttlSeconds (deadline = now + ttl on a ready sandbox;
    null removes it) and idleTimeoutSeconds. A new slug changes the URLs of published ports at once; old
    URLs and cookies stop working.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UpdateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
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
    body: UpdateSandboxRequest,
) -> Response[Error | Sandbox]:
    """Update a sandbox

     Changes name, slug, labels (replaced whole), ttlSeconds (deadline = now + ttl on a ready sandbox;
    null removes it) and idleTimeoutSeconds. A new slug changes the URLs of published ports at once; old
    URLs and cookies stop working.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UpdateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: UpdateSandboxRequest,
) -> Error | Sandbox | None:
    """Update a sandbox

     Changes name, slug, labels (replaced whole), ttlSeconds (deadline = now + ttl on a ready sandbox;
    null removes it) and idleTimeoutSeconds. A new slug changes the URLs of published ports at once; old
    URLs and cookies stop working.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UpdateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
