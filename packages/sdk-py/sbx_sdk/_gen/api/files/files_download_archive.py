from http import HTTPStatus
from io import BytesIO
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.files_download_archive_format import FilesDownloadArchiveFormat
from ...types import UNSET, File, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesDownloadArchiveFormat | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/files/archive".format(
            sandbox=quote(str(sandbox), safe=""),
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
) -> Response[Error | File]:
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
    path: str,
    user: str | Unset = UNSET,
    format_: FilesDownloadArchiveFormat | Unset = UNSET,
) -> Response[Error | File]:
    """Download a directory as tar

     The directory `path` as one tar stream (POSIX pax; `format=tar.gz` gzips it); names are relative to
    `path`, symlinks are stored as symlinks, sockets, FIFOs and devices are skipped. No Range and no
    resume: an error mid-stream cuts the response without the tar end blocks, so the client sees an
    incomplete archive. Not a directory is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesDownloadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | File]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        format_=format_,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesDownloadArchiveFormat | Unset = UNSET,
) -> Error | File | None:
    """Download a directory as tar

     The directory `path` as one tar stream (POSIX pax; `format=tar.gz` gzips it); names are relative to
    `path`, symlinks are stored as symlinks, sockets, FIFOs and devices are skipped. No Range and no
    resume: an error mid-stream cuts the response without the tar end blocks, so the client sees an
    incomplete archive. Not a directory is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesDownloadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | File
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        path=path,
        user=user,
        format_=format_,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesDownloadArchiveFormat | Unset = UNSET,
) -> Response[Error | File]:
    """Download a directory as tar

     The directory `path` as one tar stream (POSIX pax; `format=tar.gz` gzips it); names are relative to
    `path`, symlinks are stored as symlinks, sockets, FIFOs and devices are skipped. No Range and no
    resume: an error mid-stream cuts the response without the tar end blocks, so the client sees an
    incomplete archive. Not a directory is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesDownloadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | File]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        format_=format_,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesDownloadArchiveFormat | Unset = UNSET,
) -> Error | File | None:
    """Download a directory as tar

     The directory `path` as one tar stream (POSIX pax; `format=tar.gz` gzips it); names are relative to
    `path`, symlinks are stored as symlinks, sockets, FIFOs and devices are skipped. No Range and no
    resume: an error mid-stream cuts the response without the tar end blocks, so the client sees an
    incomplete archive. Not a directory is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesDownloadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | File
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            path=path,
            user=user,
            format_=format_,
        )
    ).parsed
