from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.command_attached_frame import CommandAttachedFrame
from ...models.command_error_frame import CommandErrorFrame
from ...models.command_exit_frame import CommandExitFrame
from ...models.command_heartbeat_frame import CommandHeartbeatFrame
from ...models.command_output_frame import CommandOutputFrame
from ...models.command_reconnect_frame import CommandReconnectFrame
from ...models.command_started_frame import CommandStartedFrame
from ...models.command_truncated_frame import CommandTruncatedFrame
from ...models.commands_stream_encoding import CommandsStreamEncoding
from ...models.commands_stream_follow import CommandsStreamFollow
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    command: str,
    *,
    stdout_offset: int | None | Unset = UNSET,
    stderr_offset: int | None | Unset = UNSET,
    pty_offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
    follow: CommandsStreamFollow | Unset = UNSET,
    encoding: CommandsStreamEncoding | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_stdout_offset: int | None | Unset
    if isinstance(stdout_offset, Unset):
        json_stdout_offset = UNSET
    else:
        json_stdout_offset = stdout_offset
    params["stdoutOffset"] = json_stdout_offset

    json_stderr_offset: int | None | Unset
    if isinstance(stderr_offset, Unset):
        json_stderr_offset = UNSET
    else:
        json_stderr_offset = stderr_offset
    params["stderrOffset"] = json_stderr_offset

    json_pty_offset: int | None | Unset
    if isinstance(pty_offset, Unset):
        json_pty_offset = UNSET
    else:
        json_pty_offset = pty_offset
    params["ptyOffset"] = json_pty_offset

    json_tail_bytes: int | None | Unset
    if isinstance(tail_bytes, Unset):
        json_tail_bytes = UNSET
    else:
        json_tail_bytes = tail_bytes
    params["tailBytes"] = json_tail_bytes

    json_follow: str | Unset = UNSET
    if not isinstance(follow, Unset):
        json_follow = follow.value

    params["follow"] = json_follow

    json_encoding: str | Unset = UNSET
    if not isinstance(encoding, Unset):
        json_encoding = encoding.value

    params["encoding"] = json_encoding

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/commands/{command}/stream".format(
            sandbox=quote(str(sandbox), safe=""),
            command=quote(str(command), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> (
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
):
    if response.status_code == 200:

        def _parse_response_200(
            data: object,
        ) -> (
            CommandAttachedFrame
            | CommandErrorFrame
            | CommandExitFrame
            | CommandHeartbeatFrame
            | CommandOutputFrame
            | CommandReconnectFrame
            | CommandStartedFrame
            | CommandTruncatedFrame
        ):
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_0 = CommandStartedFrame.from_dict(data)

                return componentsschemas_command_frame_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_1 = CommandAttachedFrame.from_dict(data)

                return componentsschemas_command_frame_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_2 = CommandOutputFrame.from_dict(data)

                return componentsschemas_command_frame_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_3 = CommandTruncatedFrame.from_dict(data)

                return componentsschemas_command_frame_type_3
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_4 = CommandHeartbeatFrame.from_dict(data)

                return componentsschemas_command_frame_type_4
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_5 = CommandReconnectFrame.from_dict(data)

                return componentsschemas_command_frame_type_5
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_command_frame_type_6 = CommandExitFrame.from_dict(data)

                return componentsschemas_command_frame_type_6
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, dict):
                raise TypeError()
            componentsschemas_command_frame_type_7 = CommandErrorFrame.from_dict(data)

            return componentsschemas_command_frame_type_7

        response_200 = _parse_response_200(response.content)

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 416:
        response_416 = Error.from_dict(response.json())

        return response_416

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
]:
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
    stdout_offset: int | None | Unset = UNSET,
    stderr_offset: int | None | Unset = UNSET,
    pty_offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
    follow: CommandsStreamFollow | Unset = UNSET,
    encoding: CommandsStreamEncoding | Unset = UNSET,
) -> Response[
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
]:
    """Attach to a command's output

     NDJSON frames from the given offsets (first `attached`). `tailBytes` starts each stream that many
    bytes before its end; `follow=false` sends what exists and closes. Reopen with the offsets of the
    last frame after `reconnect`, a retryable `error` or a dropped connection (no line for 45 s;
    heartbeats come every 15 s). An offset past the end of its stream is 416; a non-zero offset of a
    stream the command does not have is 400.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stdout_offset (int | None | Unset):
        stderr_offset (int | None | Unset):
        pty_offset (int | None | Unset):
        tail_bytes (int | None | Unset): Start each stream this many bytes before its end (ignores
            the offsets)
        follow (CommandsStreamFollow | Unset): false: send what exists and close (exit if it has
            exited); default true
        encoding (CommandsStreamEncoding | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandAttachedFrame | CommandErrorFrame | CommandExitFrame | CommandHeartbeatFrame | CommandOutputFrame | CommandReconnectFrame | CommandStartedFrame | CommandTruncatedFrame | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        stdout_offset=stdout_offset,
        stderr_offset=stderr_offset,
        pty_offset=pty_offset,
        tail_bytes=tail_bytes,
        follow=follow,
        encoding=encoding,
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
    stdout_offset: int | None | Unset = UNSET,
    stderr_offset: int | None | Unset = UNSET,
    pty_offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
    follow: CommandsStreamFollow | Unset = UNSET,
    encoding: CommandsStreamEncoding | Unset = UNSET,
) -> (
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
    | None
):
    """Attach to a command's output

     NDJSON frames from the given offsets (first `attached`). `tailBytes` starts each stream that many
    bytes before its end; `follow=false` sends what exists and closes. Reopen with the offsets of the
    last frame after `reconnect`, a retryable `error` or a dropped connection (no line for 45 s;
    heartbeats come every 15 s). An offset past the end of its stream is 416; a non-zero offset of a
    stream the command does not have is 400.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stdout_offset (int | None | Unset):
        stderr_offset (int | None | Unset):
        pty_offset (int | None | Unset):
        tail_bytes (int | None | Unset): Start each stream this many bytes before its end (ignores
            the offsets)
        follow (CommandsStreamFollow | Unset): false: send what exists and close (exit if it has
            exited); default true
        encoding (CommandsStreamEncoding | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandAttachedFrame | CommandErrorFrame | CommandExitFrame | CommandHeartbeatFrame | CommandOutputFrame | CommandReconnectFrame | CommandStartedFrame | CommandTruncatedFrame | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        command=command,
        client=client,
        stdout_offset=stdout_offset,
        stderr_offset=stderr_offset,
        pty_offset=pty_offset,
        tail_bytes=tail_bytes,
        follow=follow,
        encoding=encoding,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stdout_offset: int | None | Unset = UNSET,
    stderr_offset: int | None | Unset = UNSET,
    pty_offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
    follow: CommandsStreamFollow | Unset = UNSET,
    encoding: CommandsStreamEncoding | Unset = UNSET,
) -> Response[
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
]:
    """Attach to a command's output

     NDJSON frames from the given offsets (first `attached`). `tailBytes` starts each stream that many
    bytes before its end; `follow=false` sends what exists and closes. Reopen with the offsets of the
    last frame after `reconnect`, a retryable `error` or a dropped connection (no line for 45 s;
    heartbeats come every 15 s). An offset past the end of its stream is 416; a non-zero offset of a
    stream the command does not have is 400.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stdout_offset (int | None | Unset):
        stderr_offset (int | None | Unset):
        pty_offset (int | None | Unset):
        tail_bytes (int | None | Unset): Start each stream this many bytes before its end (ignores
            the offsets)
        follow (CommandsStreamFollow | Unset): false: send what exists and close (exit if it has
            exited); default true
        encoding (CommandsStreamEncoding | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandAttachedFrame | CommandErrorFrame | CommandExitFrame | CommandHeartbeatFrame | CommandOutputFrame | CommandReconnectFrame | CommandStartedFrame | CommandTruncatedFrame | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        command=command,
        stdout_offset=stdout_offset,
        stderr_offset=stderr_offset,
        pty_offset=pty_offset,
        tail_bytes=tail_bytes,
        follow=follow,
        encoding=encoding,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    command: str,
    *,
    client: AuthenticatedClient | Client,
    stdout_offset: int | None | Unset = UNSET,
    stderr_offset: int | None | Unset = UNSET,
    pty_offset: int | None | Unset = UNSET,
    tail_bytes: int | None | Unset = UNSET,
    follow: CommandsStreamFollow | Unset = UNSET,
    encoding: CommandsStreamEncoding | Unset = UNSET,
) -> (
    CommandAttachedFrame
    | CommandErrorFrame
    | CommandExitFrame
    | CommandHeartbeatFrame
    | CommandOutputFrame
    | CommandReconnectFrame
    | CommandStartedFrame
    | CommandTruncatedFrame
    | Error
    | None
):
    """Attach to a command's output

     NDJSON frames from the given offsets (first `attached`). `tailBytes` starts each stream that many
    bytes before its end; `follow=false` sends what exists and closes. Reopen with the offsets of the
    last frame after `reconnect`, a retryable `error` or a dropped connection (no line for 45 s;
    heartbeats come every 15 s). An offset past the end of its stream is 416; a non-zero offset of a
    stream the command does not have is 400.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        command (str): Command id (`cmd_...`) Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        stdout_offset (int | None | Unset):
        stderr_offset (int | None | Unset):
        pty_offset (int | None | Unset):
        tail_bytes (int | None | Unset): Start each stream this many bytes before its end (ignores
            the offsets)
        follow (CommandsStreamFollow | Unset): false: send what exists and close (exit if it has
            exited); default true
        encoding (CommandsStreamEncoding | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandAttachedFrame | CommandErrorFrame | CommandExitFrame | CommandHeartbeatFrame | CommandOutputFrame | CommandReconnectFrame | CommandStartedFrame | CommandTruncatedFrame | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            command=command,
            client=client,
            stdout_offset=stdout_offset,
            stderr_offset=stderr_offset,
            pty_offset=pty_offset,
            tail_bytes=tail_bytes,
            follow=follow,
            encoding=encoding,
        )
    ).parsed
