from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    command: str,
    *,
    offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_offset: int | None | Unset
    if isinstance(offset, Unset):
        json_offset = UNSET
    else:
        json_offset = offset
    params["offset"] = json_offset

    json_tail_bytes: int | None | Unset
    if isinstance(tail_bytes, Unset):
        json_tail_bytes = UNSET
    else:
        json_tail_bytes = tail_bytes
    params["tailBytes"] = json_tail_bytes

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/ptys/{command}/connect".format(
            sandbox=quote(str(sandbox), safe=""),
            command=quote(str(command), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 101:
        response_101 = cast(Any, None)
        return response_101

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 426:
        response_426 = Error.from_dict(response.json())

        return response_426

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

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
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
) -> Response[Any | Error]:
    """Connect to a terminal (WebSocket)

     WebSocket upgrade with the subprotocol `sbx.pty.v1` (required). Server → client: binary frames are
    consecutive PTY output bytes; text frames are JSON: `{"type":"attached","offset":N}` first,
    `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (as in NDJSON),
    `{"type":"error","code","message","retryable","details","requestId"}`,
    `{"type":"reconnect","offset":N,"reason"}`. The client counts the offset itself: `attached.offset`
    (or `availableFrom` after truncated) plus the bytes received. Client → server: binary frames are
    input (a key typed while the socket drops may be lost, never applied twice); text
    `{"type":"resize","cols":N,"rows":N}`. Close codes: 1000 after exit; 1012 server shutdown (after
    `reconnect`); 4401 unauthorized; 4403 forbidden; 4404 no such PTY; 4409 sandbox not ready; 4503
    agent unavailable (reconnect later); 1008 malformed control frame. Reconnect with `offset` = your
    count; `tailBytes` for scrollback. Pings every 15 s. Authentication as for other requests; in the
    browser (dashboard origin) the session, with `Origin` checked and `?team=` instead of the Sbx-Team
    header.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Output from this byte offset (default 0): the offset counted
            by the client, `attached.offset` (or `truncated.availableFrom`) plus the bytes received
        tail_bytes (int | None | Unset): Start this many bytes before the end of the output
            (scrollback; ignores offset)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        offset=offset,
        tail_bytes=tail_bytes,
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
    offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
) -> Any | Error | None:
    """Connect to a terminal (WebSocket)

     WebSocket upgrade with the subprotocol `sbx.pty.v1` (required). Server → client: binary frames are
    consecutive PTY output bytes; text frames are JSON: `{"type":"attached","offset":N}` first,
    `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (as in NDJSON),
    `{"type":"error","code","message","retryable","details","requestId"}`,
    `{"type":"reconnect","offset":N,"reason"}`. The client counts the offset itself: `attached.offset`
    (or `availableFrom` after truncated) plus the bytes received. Client → server: binary frames are
    input (a key typed while the socket drops may be lost, never applied twice); text
    `{"type":"resize","cols":N,"rows":N}`. Close codes: 1000 after exit; 1012 server shutdown (after
    `reconnect`); 4401 unauthorized; 4403 forbidden; 4404 no such PTY; 4409 sandbox not ready; 4503
    agent unavailable (reconnect later); 1008 malformed control frame. Reconnect with `offset` = your
    count; `tailBytes` for scrollback. Pings every 15 s. Authentication as for other requests; in the
    browser (dashboard origin) the session, with `Origin` checked and `?team=` instead of the Sbx-Team
    header.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Output from this byte offset (default 0): the offset counted
            by the client, `attached.offset` (or `truncated.availableFrom`) plus the bytes received
        tail_bytes (int | None | Unset): Start this many bytes before the end of the output
            (scrollback; ignores offset)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        command=command,
        client=client,
        offset=offset,
        tail_bytes=tail_bytes,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
) -> Response[Any | Error]:
    """Connect to a terminal (WebSocket)

     WebSocket upgrade with the subprotocol `sbx.pty.v1` (required). Server → client: binary frames are
    consecutive PTY output bytes; text frames are JSON: `{"type":"attached","offset":N}` first,
    `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (as in NDJSON),
    `{"type":"error","code","message","retryable","details","requestId"}`,
    `{"type":"reconnect","offset":N,"reason"}`. The client counts the offset itself: `attached.offset`
    (or `availableFrom` after truncated) plus the bytes received. Client → server: binary frames are
    input (a key typed while the socket drops may be lost, never applied twice); text
    `{"type":"resize","cols":N,"rows":N}`. Close codes: 1000 after exit; 1012 server shutdown (after
    `reconnect`); 4401 unauthorized; 4403 forbidden; 4404 no such PTY; 4409 sandbox not ready; 4503
    agent unavailable (reconnect later); 1008 malformed control frame. Reconnect with `offset` = your
    count; `tailBytes` for scrollback. Pings every 15 s. Authentication as for other requests; in the
    browser (dashboard origin) the session, with `Origin` checked and `?team=` instead of the Sbx-Team
    header.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Output from this byte offset (default 0): the offset counted
            by the client, `attached.offset` (or `truncated.availableFrom`) plus the bytes received
        tail_bytes (int | None | Unset): Start this many bytes before the end of the output
            (scrollback; ignores offset)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        offset=offset,
        tail_bytes=tail_bytes,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
) -> Any | Error | None:
    """Connect to a terminal (WebSocket)

     WebSocket upgrade with the subprotocol `sbx.pty.v1` (required). Server → client: binary frames are
    consecutive PTY output bytes; text frames are JSON: `{"type":"attached","offset":N}` first,
    `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (as in NDJSON),
    `{"type":"error","code","message","retryable","details","requestId"}`,
    `{"type":"reconnect","offset":N,"reason"}`. The client counts the offset itself: `attached.offset`
    (or `availableFrom` after truncated) plus the bytes received. Client → server: binary frames are
    input (a key typed while the socket drops may be lost, never applied twice); text
    `{"type":"resize","cols":N,"rows":N}`. Close codes: 1000 after exit; 1012 server shutdown (after
    `reconnect`); 4401 unauthorized; 4403 forbidden; 4404 no such PTY; 4409 sandbox not ready; 4503
    agent unavailable (reconnect later); 1008 malformed control frame. Reconnect with `offset` = your
    count; `tailBytes` for scrollback. Pings every 15 s. Authentication as for other requests; in the
    browser (dashboard origin) the session, with `Origin` checked and `?team=` instead of the Sbx-Team
    header.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Output from this byte offset (default 0): the offset counted
            by the client, `attached.offset` (or `truncated.availableFrom`) plus the bytes received
        tail_bytes (int | None | Unset): Start this many bytes before the end of the output
            (scrollback; ignores offset)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            command=command,
            client=client,
            offset=offset,
            tail_bytes=tail_bytes,
        )
    ).parsed
