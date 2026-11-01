from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.desktop_set_clipboard_body import DesktopSetClipboardBody
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    sandbox: str,
    *,
    body: DesktopSetClipboardBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/desktop/clipboard".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

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
    body: DesktopSetClipboardBody,
) -> Response[Any | Error]:
    """Desktop setClipboard

     setClipboard for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopSetClipboardBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopSetClipboardBody,
) -> Any | Error | None:
    """Desktop setClipboard

     setClipboard for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopSetClipboardBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopSetClipboardBody,
) -> Response[Any | Error]:
    """Desktop setClipboard

     setClipboard for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopSetClipboardBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    body: DesktopSetClipboardBody,
) -> Any | Error | None:
    """Desktop setClipboard

     setClipboard for the sandbox desktop. Requires the desktop template capability and a ready sandbox.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (DesktopSetClipboardBody):

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
            body=body,
        )
    ).parsed
