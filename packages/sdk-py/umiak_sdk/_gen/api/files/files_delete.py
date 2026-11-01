from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.file_remove_result import FileRemoveResult
from ...models.files_delete_recursive import FilesDeleteRecursive
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    path: str,
    user: str | Unset = UNSET,
    recursive: FilesDeleteRecursive | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    json_recursive: str | Unset = UNSET
    if not isinstance(recursive, Unset):
        json_recursive = recursive.value

    params["recursive"] = json_recursive

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/sandboxes/{sandbox}/files".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | FileRemoveResult:
    if response.status_code == 200:
        response_200 = FileRemoveResult.from_dict(response.json())

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
) -> Response[Error | FileRemoveResult]:
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
    recursive: FilesDeleteRecursive | Unset = UNSET,
) -> Response[Error | FileRemoveResult]:
    """Delete a path

     Removes a file, symlink or directory (a non-empty directory needs recursive=true, else 409
    invalid_state). A missing path is a success with existed: false.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        recursive (FilesDeleteRecursive | Unset): Remove a directory with its contents (default
            false); symlinks are not followed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileRemoveResult]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        recursive=recursive,
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
    recursive: FilesDeleteRecursive | Unset = UNSET,
) -> Error | FileRemoveResult | None:
    """Delete a path

     Removes a file, symlink or directory (a non-empty directory needs recursive=true, else 409
    invalid_state). A missing path is a success with existed: false.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        recursive (FilesDeleteRecursive | Unset): Remove a directory with its contents (default
            false); symlinks are not followed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileRemoveResult
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        path=path,
        user=user,
        recursive=recursive,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    recursive: FilesDeleteRecursive | Unset = UNSET,
) -> Response[Error | FileRemoveResult]:
    """Delete a path

     Removes a file, symlink or directory (a non-empty directory needs recursive=true, else 409
    invalid_state). A missing path is a success with existed: false.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        recursive (FilesDeleteRecursive | Unset): Remove a directory with its contents (default
            false); symlinks are not followed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileRemoveResult]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        recursive=recursive,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    recursive: FilesDeleteRecursive | Unset = UNSET,
) -> Error | FileRemoveResult | None:
    """Delete a path

     Removes a file, symlink or directory (a non-empty directory needs recursive=true, else 409
    invalid_state). A missing path is a success with existed: false.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        recursive (FilesDeleteRecursive | Unset): Remove a directory with its contents (default
            false); symlinks are not followed

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileRemoveResult
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            path=path,
            user=user,
            recursive=recursive,
        )
    ).parsed
