from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.operation import Operation
from ...types import UNSET, Response, Unset


def _get_kwargs(
    operation: str,
    *,
    wait_seconds: int | None | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_wait_seconds: int | None | Unset
    if isinstance(wait_seconds, Unset):
        json_wait_seconds = UNSET
    else:
        json_wait_seconds = wait_seconds
    params["waitSeconds"] = json_wait_seconds

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/operations/{operation}".format(
            operation=quote(str(operation), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Operation:
    if response.status_code == 200:
        response_200 = Operation.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | Operation]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    operation: str,
    *,
    client: AuthenticatedClient | Client,
    wait_seconds: int | None | Unset = UNSET,
) -> Response[Error | Operation]:
    """Get an operation (long-poll)

     An operation of the team's sandboxes. With `waitSeconds` (up to 60) the answer comes as soon as the
    operation is final (succeeded, failed, superseded), else after the timeout with its current state;
    200 either way.

    Args:
        operation (str): Operation id (`op_...`) Example: op_01jbx2v7d3m6c8q9w0e4r5t6y7.
        wait_seconds (int | None | Unset): Long-poll: answer once the operation is final or after
            this many seconds (0-60)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Operation]
    """

    kwargs = _get_kwargs(
        operation=operation,
        wait_seconds=wait_seconds,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    operation: str,
    *,
    client: AuthenticatedClient | Client,
    wait_seconds: int | None | Unset = UNSET,
) -> Error | Operation | None:
    """Get an operation (long-poll)

     An operation of the team's sandboxes. With `waitSeconds` (up to 60) the answer comes as soon as the
    operation is final (succeeded, failed, superseded), else after the timeout with its current state;
    200 either way.

    Args:
        operation (str): Operation id (`op_...`) Example: op_01jbx2v7d3m6c8q9w0e4r5t6y7.
        wait_seconds (int | None | Unset): Long-poll: answer once the operation is final or after
            this many seconds (0-60)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Operation
    """

    return sync_detailed(
        operation=operation,
        client=client,
        wait_seconds=wait_seconds,
    ).parsed


async def asyncio_detailed(
    operation: str,
    *,
    client: AuthenticatedClient | Client,
    wait_seconds: int | None | Unset = UNSET,
) -> Response[Error | Operation]:
    """Get an operation (long-poll)

     An operation of the team's sandboxes. With `waitSeconds` (up to 60) the answer comes as soon as the
    operation is final (succeeded, failed, superseded), else after the timeout with its current state;
    200 either way.

    Args:
        operation (str): Operation id (`op_...`) Example: op_01jbx2v7d3m6c8q9w0e4r5t6y7.
        wait_seconds (int | None | Unset): Long-poll: answer once the operation is final or after
            this many seconds (0-60)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Operation]
    """

    kwargs = _get_kwargs(
        operation=operation,
        wait_seconds=wait_seconds,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    operation: str,
    *,
    client: AuthenticatedClient | Client,
    wait_seconds: int | None | Unset = UNSET,
) -> Error | Operation | None:
    """Get an operation (long-poll)

     An operation of the team's sandboxes. With `waitSeconds` (up to 60) the answer comes as soon as the
    operation is final (succeeded, failed, superseded), else after the timeout with its current state;
    200 either way.

    Args:
        operation (str): Operation id (`op_...`) Example: op_01jbx2v7d3m6c8q9w0e4r5t6y7.
        wait_seconds (int | None | Unset): Long-poll: answer once the operation is final or after
            this many seconds (0-60)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Operation
    """

    return (
        await asyncio_detailed(
            operation=operation,
            client=client,
            wait_seconds=wait_seconds,
        )
    ).parsed
