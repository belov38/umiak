from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.file_info import FileInfo
from ...models.files_write_make_parents import FilesWriteMakeParents
from ...models.files_write_overwrite import FilesWriteOverwrite
from ...types import UNSET, File, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    mode: str | Unset = UNSET,
    make_parents: FilesWriteMakeParents | Unset = UNSET,
    overwrite: FilesWriteOverwrite | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    params["mode"] = mode

    json_make_parents: str | Unset = UNSET
    if not isinstance(make_parents, Unset):
        json_make_parents = make_parents.value

    params["makeParents"] = json_make_parents

    json_overwrite: str | Unset = UNSET
    if not isinstance(overwrite, Unset):
        json_overwrite = overwrite.value

    params["overwrite"] = json_overwrite

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/files/content".format(
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
) -> Error | FileInfo:
    if response.status_code == 200:
        response_200 = FileInfo.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 507:
        response_507 = Error.from_dict(response.json())

        return response_507

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | FileInfo]:
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
    mode: str | Unset = UNSET,
    make_parents: FilesWriteMakeParents | Unset = UNSET,
    overwrite: FilesWriteOverwrite | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Write a file

     Writes the request body (any size and content type, streamed) to `path` atomically: a temporary file
    in the same directory, then rename. Not resumable: a broken request writes nothing and is repeated
    whole (the same body gives the same result). For files over 64 MiB use the resumable upload (POST
    .../files/uploads).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        mode (str | Unset): Octal mode of the file (default 644) Example: 0755.
        make_parents (FilesWriteMakeParents | Unset): Create missing parent directories (default
            true)
        overwrite (FilesWriteOverwrite | Unset): Replace an existing file (default true); false:
            409 already_exists
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        path=path,
        user=user,
        mode=mode,
        make_parents=make_parents,
        overwrite=overwrite,
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
    mode: str | Unset = UNSET,
    make_parents: FilesWriteMakeParents | Unset = UNSET,
    overwrite: FilesWriteOverwrite | Unset = UNSET,
) -> Error | FileInfo | None:
    """Write a file

     Writes the request body (any size and content type, streamed) to `path` atomically: a temporary file
    in the same directory, then rename. Not resumable: a broken request writes nothing and is repeated
    whole (the same body gives the same result). For files over 64 MiB use the resumable upload (POST
    .../files/uploads).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        mode (str | Unset): Octal mode of the file (default 644) Example: 0755.
        make_parents (FilesWriteMakeParents | Unset): Create missing parent directories (default
            true)
        overwrite (FilesWriteOverwrite | Unset): Replace an existing file (default true); false:
            409 already_exists
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileInfo
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
        path=path,
        user=user,
        mode=mode,
        make_parents=make_parents,
        overwrite=overwrite,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    path: str,
    user: str | Unset = UNSET,
    mode: str | Unset = UNSET,
    make_parents: FilesWriteMakeParents | Unset = UNSET,
    overwrite: FilesWriteOverwrite | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Write a file

     Writes the request body (any size and content type, streamed) to `path` atomically: a temporary file
    in the same directory, then rename. Not resumable: a broken request writes nothing and is repeated
    whole (the same body gives the same result). For files over 64 MiB use the resumable upload (POST
    .../files/uploads).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        mode (str | Unset): Octal mode of the file (default 644) Example: 0755.
        make_parents (FilesWriteMakeParents | Unset): Create missing parent directories (default
            true)
        overwrite (FilesWriteOverwrite | Unset): Replace an existing file (default true); false:
            409 already_exists
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        path=path,
        user=user,
        mode=mode,
        make_parents=make_parents,
        overwrite=overwrite,
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
    mode: str | Unset = UNSET,
    make_parents: FilesWriteMakeParents | Unset = UNSET,
    overwrite: FilesWriteOverwrite | Unset = UNSET,
) -> Error | FileInfo | None:
    """Write a file

     Writes the request body (any size and content type, streamed) to `path` atomically: a temporary file
    in the same directory, then rename. Not resumable: a broken request writes nothing and is repeated
    whole (the same body gives the same result). For files over 64 MiB use the resumable upload (POST
    .../files/uploads).

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        mode (str | Unset): Octal mode of the file (default 644) Example: 0755.
        make_parents (FilesWriteMakeParents | Unset): Create missing parent directories (default
            true)
        overwrite (FilesWriteOverwrite | Unset): Replace an existing file (default true); false:
            409 already_exists
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileInfo
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
            path=path,
            user=user,
            mode=mode,
            make_parents=make_parents,
            overwrite=overwrite,
        )
    ).parsed
