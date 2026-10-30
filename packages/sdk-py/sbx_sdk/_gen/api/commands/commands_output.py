from http import HTTPStatus
from io import BytesIO
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.commands_output_stream import CommandsOutputStream
from ...models.error import Error
from ...types import UNSET, File, Response, Unset


def _get_kwargs(
    sandbox: str,
    command: str,
    *,
    stream: CommandsOutputStream | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    limit: int | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_stream: str | Unset = UNSET
    if not isinstance(stream, Unset):
        json_stream = stream.value

    params["stream"] = json_stream

    json_offset: int | None | Unset
    if isinstance(offset, Unset):
        json_offset = UNSET
    else:
        json_offset = offset
    params["offset"] = json_offset

    params["limit"] = limit

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/commands/{command}/output".format(
            sandbox=quote(str(sandbox), safe=""),
            command=quote(str(command), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | File:
    if response.status_code == 200:
        response_200 = File(payload=BytesIO(response.content))

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

    if response.status_code == 416:
        response_416 = Error.from_dict(response.json())

        return response_416

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | File]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stream: CommandsOutputStream | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    limit: int | Unset = UNSET,
) -> Response[Error | File]:
    """Read output by offset

     Raw bytes of one stream from `offset` (up to `limit`, at most 4 MiB). Headers: Sbx-Offset (where the
    bytes start), Sbx-Next-Offset, Sbx-Available-From, Sbx-Stream-End (only once the stream ended), Sbx-
    Truncated: true when `offset` was already evicted and reading started at Sbx-Available-From. An
    offset past the end is 416. For polling without streams.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stream (CommandsOutputStream | Unset): Default stdout
        offset (int | None | Unset):
        limit (int | Unset): Bytes, at most 4 MiB (default 1 MiB)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | File]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        stream=stream,
        offset=offset,
        limit=limit,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stream: CommandsOutputStream | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    limit: int | Unset = UNSET,
) -> Error | File | None:
    """Read output by offset

     Raw bytes of one stream from `offset` (up to `limit`, at most 4 MiB). Headers: Sbx-Offset (where the
    bytes start), Sbx-Next-Offset, Sbx-Available-From, Sbx-Stream-End (only once the stream ended), Sbx-
    Truncated: true when `offset` was already evicted and reading started at Sbx-Available-From. An
    offset past the end is 416. For polling without streams.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stream (CommandsOutputStream | Unset): Default stdout
        offset (int | None | Unset):
        limit (int | Unset): Bytes, at most 4 MiB (default 1 MiB)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | File
    """

    return sync_detailed(
        sandbox=sandbox,
        command=command,
        client=client,
        stream=stream,
        offset=offset,
        limit=limit,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stream: CommandsOutputStream | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    limit: int | Unset = UNSET,
) -> Response[Error | File]:
    """Read output by offset

     Raw bytes of one stream from `offset` (up to `limit`, at most 4 MiB). Headers: Sbx-Offset (where the
    bytes start), Sbx-Next-Offset, Sbx-Available-From, Sbx-Stream-End (only once the stream ended), Sbx-
    Truncated: true when `offset` was already evicted and reading started at Sbx-Available-From. An
    offset past the end is 416. For polling without streams.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stream (CommandsOutputStream | Unset): Default stdout
        offset (int | None | Unset):
        limit (int | Unset): Bytes, at most 4 MiB (default 1 MiB)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | File]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        stream=stream,
        offset=offset,
        limit=limit,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stream: CommandsOutputStream | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    limit: int | Unset = UNSET,
) -> Error | File | None:
    """Read output by offset

     Raw bytes of one stream from `offset` (up to `limit`, at most 4 MiB). Headers: Sbx-Offset (where the
    bytes start), Sbx-Next-Offset, Sbx-Available-From, Sbx-Stream-End (only once the stream ended), Sbx-
    Truncated: true when `offset` was already evicted and reading started at Sbx-Available-From. An
    offset past the end is 416. For polling without streams.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stream (CommandsOutputStream | Unset): Default stdout
        offset (int | None | Unset):
        limit (int | Unset): Bytes, at most 4 MiB (default 1 MiB)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | File
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            command=command,
            client=client,
            stream=stream,
            offset=offset,
            limit=limit,
        )
    ).parsed
