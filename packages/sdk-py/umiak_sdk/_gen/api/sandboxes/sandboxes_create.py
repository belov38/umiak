from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.create_sandbox_request import CreateSandboxRequest
from ...models.error import Error
from ...models.sandbox_action import SandboxAction
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: CreateSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes",
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxAction:
    if response.status_code == 202:
        response_202 = SandboxAction.from_dict(response.json())

        return response_202

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Error.from_dict(response.json())

        return response_422

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxAction]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxAction]:
    """Create a sandbox

     Starts a new VM sandbox from a template (or a saved snapshot with `from`) and answers 202 at once
    with the sandbox in `creating` and its `create` operation. Wait for it with GET
    /v1/sandboxes/{sandbox}?waitFor=ready. All fields are optional. The team's environment (or the one
    named in `environment`) is applied first, the request's env, secrets and secret files on top. Send
    an Idempotency-Key to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (CreateSandboxRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxAction | None:
    """Create a sandbox

     Starts a new VM sandbox from a template (or a saved snapshot with `from`) and answers 202 at once
    with the sandbox in `creating` and its `create` operation. Wait for it with GET
    /v1/sandboxes/{sandbox}?waitFor=ready. All fields are optional. The team's environment (or the one
    named in `environment`) is applied first, the request's env, secrets and secret files on top. Send
    an Idempotency-Key to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (CreateSandboxRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxAction
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxAction]:
    """Create a sandbox

     Starts a new VM sandbox from a template (or a saved snapshot with `from`) and answers 202 at once
    with the sandbox in `creating` and its `create` operation. Wait for it with GET
    /v1/sandboxes/{sandbox}?waitFor=ready. All fields are optional. The team's environment (or the one
    named in `environment`) is applied first, the request's env, secrets and secret files on top. Send
    an Idempotency-Key to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (CreateSandboxRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxAction | None:
    """Create a sandbox

     Starts a new VM sandbox from a template (or a saved snapshot with `from`) and answers 202 at once
    with the sandbox in `creating` and its `create` operation. Wait for it with GET
    /v1/sandboxes/{sandbox}?waitFor=ready. All fields are optional. The team's environment (or the one
    named in `environment`) is applied first, the request's env, secrets and secret files on top. Send
    an Idempotency-Key to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (CreateSandboxRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxAction
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
