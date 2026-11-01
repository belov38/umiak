from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    name: str,
    *,
    umiak_confirm_delete: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(umiak_confirm_delete, Unset):
        headers["Umiak-Confirm-Delete"] = umiak_confirm_delete

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/snapshots/{name}".format(
            name=quote(str(name), safe=""),
        ),
    }

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 428:
        response_428 = Error.from_dict(response.json())

        return response_428

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Any | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    name: str,
    *,
    client: AuthenticatedClient | Client,
    umiak_confirm_delete: str | Unset = UNSET,
) -> Response[Any | Error]:
    """Delete a saved snapshot

     Deletes the ready snapshot of this name; the name is free at once, the disk is removed in the
    background. Needs the header Umiak-Confirm-Delete with the snapshot id (or name) — otherwise 428 and
    nothing happens. Sandboxes created from it stay.

    Args:
        name (str): Name of the saved snapshot Example: web-stack.
        umiak_confirm_delete (str | Unset): Required: the id (`snap_...`) or the name of the
            snapshot in the path; without it or with another snapshot the answer is 428 and nothing is
            deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        name=name,
        umiak_confirm_delete=umiak_confirm_delete,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    name: str,
    *,
    client: AuthenticatedClient | Client,
    umiak_confirm_delete: str | Unset = UNSET,
) -> Any | Error | None:
    """Delete a saved snapshot

     Deletes the ready snapshot of this name; the name is free at once, the disk is removed in the
    background. Needs the header Umiak-Confirm-Delete with the snapshot id (or name) — otherwise 428 and
    nothing happens. Sandboxes created from it stay.

    Args:
        name (str): Name of the saved snapshot Example: web-stack.
        umiak_confirm_delete (str | Unset): Required: the id (`snap_...`) or the name of the
            snapshot in the path; without it or with another snapshot the answer is 428 and nothing is
            deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return sync_detailed(
        name=name,
        client=client,
        umiak_confirm_delete=umiak_confirm_delete,
    ).parsed


async def asyncio_detailed(
    name: str,
    *,
    client: AuthenticatedClient | Client,
    umiak_confirm_delete: str | Unset = UNSET,
) -> Response[Any | Error]:
    """Delete a saved snapshot

     Deletes the ready snapshot of this name; the name is free at once, the disk is removed in the
    background. Needs the header Umiak-Confirm-Delete with the snapshot id (or name) — otherwise 428 and
    nothing happens. Sandboxes created from it stay.

    Args:
        name (str): Name of the saved snapshot Example: web-stack.
        umiak_confirm_delete (str | Unset): Required: the id (`snap_...`) or the name of the
            snapshot in the path; without it or with another snapshot the answer is 428 and nothing is
            deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        name=name,
        umiak_confirm_delete=umiak_confirm_delete,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    name: str,
    *,
    client: AuthenticatedClient | Client,
    umiak_confirm_delete: str | Unset = UNSET,
) -> Any | Error | None:
    """Delete a saved snapshot

     Deletes the ready snapshot of this name; the name is free at once, the disk is removed in the
    background. Needs the header Umiak-Confirm-Delete with the snapshot id (or name) — otherwise 428 and
    nothing happens. Sandboxes created from it stay.

    Args:
        name (str): Name of the saved snapshot Example: web-stack.
        umiak_confirm_delete (str | Unset): Required: the id (`snap_...`) or the name of the
            snapshot in the path; without it or with another snapshot the answer is 428 and nothing is
            deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return (
        await asyncio_detailed(
            name=name,
            client=client,
            umiak_confirm_delete=umiak_confirm_delete,
        )
    ).parsed
