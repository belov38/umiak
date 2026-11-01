from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.file_info import FileInfo
from ...models.make_dir_request import MakeDirRequest
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: MakeDirRequest,
    user: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    params: dict[str, Any] = {}

    params["user"] = user

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/files/mkdir".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | FileInfo:
    if response.status_code == 200:
        response_200 = FileInfo.from_dict(response.json())

        return response_200

    if response.status_code == 201:
        response_201 = FileInfo.from_dict(response.json())

        return response_201

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
    body: MakeDirRequest,
    user: str | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Create a directory

     Creates a directory (with missing parents when `parents` is true). 201 when created, 200 when the
    directory already existed; another file there is 409 already_exists.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (MakeDirRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        user=user,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: MakeDirRequest,
    user: str | Unset = UNSET,
) -> Error | FileInfo | None:
    """Create a directory

     Creates a directory (with missing parents when `parents` is true). 201 when created, 200 when the
    directory already existed; another file there is 409 already_exists.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (MakeDirRequest):

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
        user=user,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: MakeDirRequest,
    user: str | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Create a directory

     Creates a directory (with missing parents when `parents` is true). 201 when created, 200 when the
    directory already existed; another file there is 409 already_exists.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (MakeDirRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
        user=user,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: MakeDirRequest,
    user: str | Unset = UNSET,
) -> Error | FileInfo | None:
    """Create a directory

     Creates a directory (with missing parents when `parents` is true). 201 when created, 200 when the
    directory already existed; another file there is 409 already_exists.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (MakeDirRequest):

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
            user=user,
        )
    ).parsed
