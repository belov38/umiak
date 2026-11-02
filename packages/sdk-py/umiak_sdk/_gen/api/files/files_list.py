from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.file_list import FileList
from ...models.files_list_include_hidden import FilesListIncludeHidden
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    path: str,
    user: str | Unset = UNSET,
    depth: int | Unset = UNSET,
    include_hidden: FilesListIncludeHidden | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    params["depth"] = depth

    json_include_hidden: str | Unset = UNSET
    if not isinstance(include_hidden, Unset):
        json_include_hidden = include_hidden.value

    params["includeHidden"] = json_include_hidden

    params["limit"] = limit

    params["cursor"] = cursor

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/files/list".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | FileList:
    if response.status_code == 200:
        response_200 = FileList.from_dict(response.json())

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

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | FileList]:
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
    depth: int | Unset = UNSET,
    include_hidden: FilesListIncludeHidden | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[Error | FileList]:
    """List a directory

     Entries under `path` (down to `depth` levels), ordered by path; symlinks are listed as symlinks and
    not followed. Pages of `limit` (default 50, at most 200); pass nextCursor as `cursor` with the same
    path. A file is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        depth (int | Unset): Levels below path, 1-8 (default 1)
        include_hidden (FilesListIncludeHidden | Unset): Include dot files (default true)
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileList]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        depth=depth,
        include_hidden=include_hidden,
        limit=limit,
        cursor=cursor,
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
    depth: int | Unset = UNSET,
    include_hidden: FilesListIncludeHidden | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Error | FileList | None:
    """List a directory

     Entries under `path` (down to `depth` levels), ordered by path; symlinks are listed as symlinks and
    not followed. Pages of `limit` (default 50, at most 200); pass nextCursor as `cursor` with the same
    path. A file is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        depth (int | Unset): Levels below path, 1-8 (default 1)
        include_hidden (FilesListIncludeHidden | Unset): Include dot files (default true)
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileList
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        path=path,
        user=user,
        depth=depth,
        include_hidden=include_hidden,
        limit=limit,
        cursor=cursor,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    depth: int | Unset = UNSET,
    include_hidden: FilesListIncludeHidden | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[Error | FileList]:
    """List a directory

     Entries under `path` (down to `depth` levels), ordered by path; symlinks are listed as symlinks and
    not followed. Pages of `limit` (default 50, at most 200); pass nextCursor as `cursor` with the same
    path. A file is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        depth (int | Unset): Levels below path, 1-8 (default 1)
        include_hidden (FilesListIncludeHidden | Unset): Include dot files (default true)
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileList]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        depth=depth,
        include_hidden=include_hidden,
        limit=limit,
        cursor=cursor,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    depth: int | Unset = UNSET,
    include_hidden: FilesListIncludeHidden | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Error | FileList | None:
    """List a directory

     Entries under `path` (down to `depth` levels), ordered by path; symlinks are listed as symlinks and
    not followed. Pages of `limit` (default 50, at most 200); pass nextCursor as `cursor` with the same
    path. A file is 409 not_directory.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        depth (int | Unset): Levels below path, 1-8 (default 1)
        include_hidden (FilesListIncludeHidden | Unset): Include dot files (default true)
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileList
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            path=path,
            user=user,
            depth=depth,
            include_hidden=include_hidden,
            limit=limit,
            cursor=cursor,
        )
    ).parsed
