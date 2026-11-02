from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.file_info import FileInfo
from ...models.files_stat_no_follow import FilesStatNoFollow
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    path: str,
    user: str | Unset = UNSET,
    no_follow: FilesStatNoFollow | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    json_no_follow: str | Unset = UNSET
    if not isinstance(no_follow, Unset):
        json_no_follow = no_follow.value

    params["noFollow"] = json_no_follow

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/files/stat".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

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
    path: str,
    user: str | Unset = UNSET,
    no_follow: FilesStatNoFollow | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Describe a path

     FileInfo of a path; follows symlinks unless noFollow=true. A missing path is 404 path_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        no_follow (FilesStatNoFollow | Unset): true: describe a symlink itself (default false)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        no_follow=no_follow,
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
    no_follow: FilesStatNoFollow | Unset = UNSET,
) -> Error | FileInfo | None:
    """Describe a path

     FileInfo of a path; follows symlinks unless noFollow=true. A missing path is 404 path_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        no_follow (FilesStatNoFollow | Unset): true: describe a symlink itself (default false)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileInfo
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        path=path,
        user=user,
        no_follow=no_follow,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    no_follow: FilesStatNoFollow | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Describe a path

     FileInfo of a path; follows symlinks unless noFollow=true. A missing path is 404 path_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        no_follow (FilesStatNoFollow | Unset): true: describe a symlink itself (default false)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
        no_follow=no_follow,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
    no_follow: FilesStatNoFollow | Unset = UNSET,
) -> Error | FileInfo | None:
    """Describe a path

     FileInfo of a path; follows symlinks unless noFollow=true. A missing path is 404 path_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        no_follow (FilesStatNoFollow | Unset): true: describe a symlink itself (default false)

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
            path=path,
            user=user,
            no_follow=no_follow,
        )
    ).parsed
