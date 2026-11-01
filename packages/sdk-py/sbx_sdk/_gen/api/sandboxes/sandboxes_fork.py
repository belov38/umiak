from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.fork_sandbox_request import ForkSandboxRequest
from ...models.sandbox_fork import SandboxFork
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: ForkSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/fork".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxFork:
    if response.status_code == 202:
        response_202 = SandboxFork.from_dict(response.json())

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

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxFork]:
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
    body: ForkSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxFork]:
    """Fork a sandbox

     Creates a new sandbox from a snapshot of this one (disk and env/secrets copied; the request's sets
    merge on top). Answers 202 with the new sandbox, its `create` operation and the `fork` operation on
    the source. A running Windows sandbox is forked only from a stopped VM: send `forceStop: true` to
    stop it, snapshot it and start it again, otherwise 409 `snapshot_requires_stop`. Send an
    Idempotency-Key to retry safely.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (ForkSandboxRequest | Unset): Sets merge onto a copy of the source's sets; the source
            is not changed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxFork]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: ForkSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxFork | None:
    """Fork a sandbox

     Creates a new sandbox from a snapshot of this one (disk and env/secrets copied; the request's sets
    merge on top). Answers 202 with the new sandbox, its `create` operation and the `fork` operation on
    the source. A running Windows sandbox is forked only from a stopped VM: send `forceStop: true` to
    stop it, snapshot it and start it again, otherwise 409 `snapshot_requires_stop`. Send an
    Idempotency-Key to retry safely.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (ForkSandboxRequest | Unset): Sets merge onto a copy of the source's sets; the source
            is not changed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxFork
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: ForkSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxFork]:
    """Fork a sandbox

     Creates a new sandbox from a snapshot of this one (disk and env/secrets copied; the request's sets
    merge on top). Answers 202 with the new sandbox, its `create` operation and the `fork` operation on
    the source. A running Windows sandbox is forked only from a stopped VM: send `forceStop: true` to
    stop it, snapshot it and start it again, otherwise 409 `snapshot_requires_stop`. Send an
    Idempotency-Key to retry safely.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (ForkSandboxRequest | Unset): Sets merge onto a copy of the source's sets; the source
            is not changed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxFork]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: ForkSandboxRequest | Unset = UNSET,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxFork | None:
    """Fork a sandbox

     Creates a new sandbox from a snapshot of this one (disk and env/secrets copied; the request's sets
    merge on top). Answers 202 with the new sandbox, its `create` operation and the `fork` operation on
    the source. A running Windows sandbox is forked only from a stopped VM: send `forceStop: true` to
    stop it, snapshot it and start it again, otherwise 409 `snapshot_requires_stop`. Send an
    Idempotency-Key to retry safely.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of creating again (24 h)
        body (ForkSandboxRequest | Unset): Sets merge onto a copy of the source's sets; the source
            is not changed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxFork
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
