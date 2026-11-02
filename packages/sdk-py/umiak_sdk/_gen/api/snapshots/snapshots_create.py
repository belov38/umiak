from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.create_snapshot_request import CreateSnapshotRequest
from ...models.error import Error
from ...models.snapshot_create import SnapshotCreate
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: CreateSnapshotRequest,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/snapshots",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SnapshotCreate:
    if response.status_code == 202:
        response_202 = SnapshotCreate.from_dict(response.json())

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

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SnapshotCreate]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSnapshotRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SnapshotCreate]:
    """Save a snapshot of a sandbox

     Takes a snapshot of the sandbox (ready or stopped) under `name` and answers 202 with the snapshot in
    `creating` and the `save_snapshot` operation of the sandbox; wait with GET
    /v1/operations/{operation}?waitSeconds=. A ready snapshot with the same name is replaced once the
    new one is ready. A running Windows sandbox is saved only from a stopped VM: send `forceStop: true`
    to stop it, save and start it again, otherwise 409 `snapshot_requires_stop`. Send an Idempotency-Key
    to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of saving again (24 h)
        body (CreateSnapshotRequest): A ready snapshot with this name is replaced once the new one
            is ready

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SnapshotCreate]
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
    body: CreateSnapshotRequest,
    idempotency_key: str | Unset = UNSET,
) -> Error | SnapshotCreate | None:
    """Save a snapshot of a sandbox

     Takes a snapshot of the sandbox (ready or stopped) under `name` and answers 202 with the snapshot in
    `creating` and the `save_snapshot` operation of the sandbox; wait with GET
    /v1/operations/{operation}?waitSeconds=. A ready snapshot with the same name is replaced once the
    new one is ready. A running Windows sandbox is saved only from a stopped VM: send `forceStop: true`
    to stop it, save and start it again, otherwise 409 `snapshot_requires_stop`. Send an Idempotency-Key
    to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of saving again (24 h)
        body (CreateSnapshotRequest): A ready snapshot with this name is replaced once the new one
            is ready

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SnapshotCreate
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSnapshotRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SnapshotCreate]:
    """Save a snapshot of a sandbox

     Takes a snapshot of the sandbox (ready or stopped) under `name` and answers 202 with the snapshot in
    `creating` and the `save_snapshot` operation of the sandbox; wait with GET
    /v1/operations/{operation}?waitSeconds=. A ready snapshot with the same name is replaced once the
    new one is ready. A running Windows sandbox is saved only from a stopped VM: send `forceStop: true`
    to stop it, save and start it again, otherwise 409 `snapshot_requires_stop`. Send an Idempotency-Key
    to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of saving again (24 h)
        body (CreateSnapshotRequest): A ready snapshot with this name is replaced once the new one
            is ready

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SnapshotCreate]
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
    body: CreateSnapshotRequest,
    idempotency_key: str | Unset = UNSET,
) -> Error | SnapshotCreate | None:
    """Save a snapshot of a sandbox

     Takes a snapshot of the sandbox (ready or stopped) under `name` and answers 202 with the snapshot in
    `creating` and the `save_snapshot` operation of the sandbox; wait with GET
    /v1/operations/{operation}?waitSeconds=. A ready snapshot with the same name is replaced once the
    new one is ready. A running Windows sandbox is saved only from a stopped VM: send `forceStop: true`
    to stop it, save and start it again, otherwise 409 `snapshot_requires_stop`. Send an Idempotency-Key
    to retry safely.

    Args:
        idempotency_key (str | Unset): 1-255 printable ASCII characters; a repeat with the same
            key and body returns the stored result instead of saving again (24 h)
        body (CreateSnapshotRequest): A ready snapshot with this name is replaced once the new one
            is ready

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SnapshotCreate
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
