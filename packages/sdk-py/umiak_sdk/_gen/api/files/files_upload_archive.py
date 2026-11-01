from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.archive_result import ArchiveResult
from ...models.error import Error
from ...models.files_upload_archive_format import FilesUploadArchiveFormat
from ...models.files_upload_archive_make_parents import FilesUploadArchiveMakeParents
from ...models.files_upload_archive_overwrite import FilesUploadArchiveOverwrite
from ...types import UNSET, File, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesUploadArchiveFormat | Unset = UNSET,
    overwrite: FilesUploadArchiveOverwrite | Unset = UNSET,
    make_parents: FilesUploadArchiveMakeParents | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    json_overwrite: str | Unset = UNSET
    if not isinstance(overwrite, Unset):
        json_overwrite = overwrite.value

    params["overwrite"] = json_overwrite

    json_make_parents: str | Unset = UNSET
    if not isinstance(make_parents, Unset):
        json_make_parents = make_parents.value

    params["makeParents"] = json_make_parents

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/files/archive".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    if not isinstance(body, Unset):
        _kwargs["content"] = body.payload
    headers["Content-Type"] = "application/octet-stream"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ArchiveResult | Error:
    if response.status_code == 200:
        response_200 = ArchiveResult.from_dict(response.json())

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

    if response.status_code == 413:
        response_413 = Error.from_dict(response.json())

        return response_413

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ArchiveResult | Error]:
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
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesUploadArchiveFormat | Unset = UNSET,
    overwrite: FilesUploadArchiveOverwrite | Unset = UNSET,
    make_parents: FilesUploadArchiveMakeParents | Unset = UNSET,
) -> Response[ArchiveResult | Error]:
    """Unpack a tar into a directory

     Unpacks the streamed body (tar, or tar.gz with format=tar.gz) into the directory `path`. Owner is
    `user`; uid/gid of the archive are ignored, setuid/setgid dropped. Limits: 200 000 entries, 16 GiB
    of data, 4 096-byte paths, else 413. Absolute paths, `..`, hard links out of the archive, devices
    and FIFOs, and writing through a symlink (from the archive or already on disk) are 400 invalid_path.
    Not atomic: on an error what was written stays (details.entriesWritten); unpack into a new directory
    and move it for atomicity. Not resumable: repeat the whole archive (safe with overwrite=true).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesUploadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz
        overwrite (FilesUploadArchiveOverwrite | Unset): Replace existing files (default true);
            false: 409 already_exists
        make_parents (FilesUploadArchiveMakeParents | Unset): Create the directory and its parents
            (default true)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ArchiveResult | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        path=path,
        user=user,
        format_=format_,
        overwrite=overwrite,
        make_parents=make_parents,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesUploadArchiveFormat | Unset = UNSET,
    overwrite: FilesUploadArchiveOverwrite | Unset = UNSET,
    make_parents: FilesUploadArchiveMakeParents | Unset = UNSET,
) -> ArchiveResult | Error | None:
    """Unpack a tar into a directory

     Unpacks the streamed body (tar, or tar.gz with format=tar.gz) into the directory `path`. Owner is
    `user`; uid/gid of the archive are ignored, setuid/setgid dropped. Limits: 200 000 entries, 16 GiB
    of data, 4 096-byte paths, else 413. Absolute paths, `..`, hard links out of the archive, devices
    and FIFOs, and writing through a symlink (from the archive or already on disk) are 400 invalid_path.
    Not atomic: on an error what was written stays (details.entriesWritten); unpack into a new directory
    and move it for atomicity. Not resumable: repeat the whole archive (safe with overwrite=true).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesUploadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz
        overwrite (FilesUploadArchiveOverwrite | Unset): Replace existing files (default true);
            false: 409 already_exists
        make_parents (FilesUploadArchiveMakeParents | Unset): Create the directory and its parents
            (default true)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ArchiveResult | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
        path=path,
        user=user,
        format_=format_,
        overwrite=overwrite,
        make_parents=make_parents,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesUploadArchiveFormat | Unset = UNSET,
    overwrite: FilesUploadArchiveOverwrite | Unset = UNSET,
    make_parents: FilesUploadArchiveMakeParents | Unset = UNSET,
) -> Response[ArchiveResult | Error]:
    """Unpack a tar into a directory

     Unpacks the streamed body (tar, or tar.gz with format=tar.gz) into the directory `path`. Owner is
    `user`; uid/gid of the archive are ignored, setuid/setgid dropped. Limits: 200 000 entries, 16 GiB
    of data, 4 096-byte paths, else 413. Absolute paths, `..`, hard links out of the archive, devices
    and FIFOs, and writing through a symlink (from the archive or already on disk) are 400 invalid_path.
    Not atomic: on an error what was written stays (details.entriesWritten); unpack into a new directory
    and move it for atomicity. Not resumable: repeat the whole archive (safe with overwrite=true).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesUploadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz
        overwrite (FilesUploadArchiveOverwrite | Unset): Replace existing files (default true);
            false: 409 already_exists
        make_parents (FilesUploadArchiveMakeParents | Unset): Create the directory and its parents
            (default true)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ArchiveResult | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        path=path,
        user=user,
        format_=format_,
        overwrite=overwrite,
        make_parents=make_parents,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    format_: FilesUploadArchiveFormat | Unset = UNSET,
    overwrite: FilesUploadArchiveOverwrite | Unset = UNSET,
    make_parents: FilesUploadArchiveMakeParents | Unset = UNSET,
) -> ArchiveResult | Error | None:
    """Unpack a tar into a directory

     Unpacks the streamed body (tar, or tar.gz with format=tar.gz) into the directory `path`. Owner is
    `user`; uid/gid of the archive are ignored, setuid/setgid dropped. Limits: 200 000 entries, 16 GiB
    of data, 4 096-byte paths, else 413. Absolute paths, `..`, hard links out of the archive, devices
    and FIFOs, and writing through a symlink (from the archive or already on disk) are 400 invalid_path.
    Not atomic: on an error what was written stays (details.entriesWritten); unpack into a new directory
    and move it for atomicity. Not resumable: repeat the whole archive (safe with overwrite=true).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): The directory. Absolute, or relative to the home directory of `user` (`~` and
            `~/...` too) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        format_ (FilesUploadArchiveFormat | Unset): tar (POSIX pax, default) or tar.gz
        overwrite (FilesUploadArchiveOverwrite | Unset): Replace existing files (default true);
            false: 409 already_exists
        make_parents (FilesUploadArchiveMakeParents | Unset): Create the directory and its parents
            (default true)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ArchiveResult | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
            path=path,
            user=user,
            format_=format_,
            overwrite=overwrite,
            make_parents=make_parents,
        )
    ).parsed
