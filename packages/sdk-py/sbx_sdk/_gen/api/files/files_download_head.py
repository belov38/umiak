from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    path: str,
    user: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["path"] = path

    params["user"] = user

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "head",
        "url": "/v1/sandboxes/{sandbox}/files/content".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 200:
        response_200 = cast(Any, None)
        return response_200

    if response.status_code == 404:
        response_404 = cast(Any, None)
        return response_404

    if response.status_code == 409:
        response_409 = cast(Any, None)
        return response_409

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
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
) -> Response[Any | Error]:
    """File headers

     The headers of GET .../files/content (size in Content-Length, ETag, Last-Modified) without the body.
    Errors have no body either: see the status.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
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
    path: str,
    user: str | Unset = UNSET,
) -> Any | Error | None:
    """File headers

     The headers of GET .../files/content (size in Content-Length, ETag, Last-Modified) without the body.
    Errors have no body either: see the status.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        path=path,
        user=user,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
) -> Response[Any | Error]:
    """File headers

     The headers of GET .../files/content (size in Content-Length, ETag, Last-Modified) without the body.
    Errors have no body either: see the status.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        path=path,
        user=user,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    path: str,
    user: str | Unset = UNSET,
) -> Any | Error | None:
    """File headers

     The headers of GET .../files/content (size in Content-Length, ETag, Last-Modified) without the body.
    Errors have no body either: see the status.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            path=path,
            user=user,
        )
    ).parsed
