from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.desktop_screenshot_cursor import DesktopScreenshotCursor
from ...models.desktop_screenshot_format import DesktopScreenshotFormat
from ...models.error import Error
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    format_: DesktopScreenshotFormat | Unset = UNSET,
    quality: int | Unset = UNSET,
    max_width: int | Unset = UNSET,
    max_height: int | Unset = UNSET,
    x: int | None | Unset = UNSET,
    y: int | None | Unset = UNSET,
    width: int | Unset = UNSET,
    height: int | Unset = UNSET,
    cursor: DesktopScreenshotCursor | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    params["quality"] = quality

    params["maxWidth"] = max_width

    params["maxHeight"] = max_height

    json_x: int | None | Unset
    if isinstance(x, Unset):
        json_x = UNSET
    else:
        json_x = x
    params["x"] = json_x

    json_y: int | None | Unset
    if isinstance(y, Unset):
        json_y = UNSET
    else:
        json_y = y
    params["y"] = json_y

    params["width"] = width

    params["height"] = height

    json_cursor: str | Unset = UNSET
    if not isinstance(cursor, Unset):
        json_cursor = cursor.value

    params["cursor"] = json_cursor

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes/{sandbox}/desktop/screenshot".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(*, client: AuthenticatedClient | Client, response: httpx.Response) -> Error:
    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error]:
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
    format_: DesktopScreenshotFormat | Unset = UNSET,
    quality: int | Unset = UNSET,
    max_width: int | Unset = UNSET,
    max_height: int | Unset = UNSET,
    x: int | None | Unset = UNSET,
    y: int | None | Unset = UNSET,
    width: int | Unset = UNSET,
    height: int | Unset = UNSET,
    cursor: DesktopScreenshotCursor | Unset = UNSET,
) -> Response[Error]:
    """Capture the desktop

     PNG or JPEG screen capture independent of the video streamer, with original screen, image and cursor
    metadata in response headers.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        format_ (DesktopScreenshotFormat | Unset):
        quality (int | Unset):
        max_width (int | Unset):
        max_height (int | Unset):
        x (int | None | Unset):
        y (int | None | Unset):
        width (int | Unset):
        height (int | Unset):
        cursor (DesktopScreenshotCursor | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        format_=format_,
        quality=quality,
        max_width=max_width,
        max_height=max_height,
        x=x,
        y=y,
        width=width,
        height=height,
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
    format_: DesktopScreenshotFormat | Unset = UNSET,
    quality: int | Unset = UNSET,
    max_width: int | Unset = UNSET,
    max_height: int | Unset = UNSET,
    x: int | None | Unset = UNSET,
    y: int | None | Unset = UNSET,
    width: int | Unset = UNSET,
    height: int | Unset = UNSET,
    cursor: DesktopScreenshotCursor | Unset = UNSET,
) -> Error | None:
    """Capture the desktop

     PNG or JPEG screen capture independent of the video streamer, with original screen, image and cursor
    metadata in response headers.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        format_ (DesktopScreenshotFormat | Unset):
        quality (int | Unset):
        max_width (int | Unset):
        max_height (int | Unset):
        x (int | None | Unset):
        y (int | None | Unset):
        width (int | Unset):
        height (int | Unset):
        cursor (DesktopScreenshotCursor | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        format_=format_,
        quality=quality,
        max_width=max_width,
        max_height=max_height,
        x=x,
        y=y,
        width=width,
        height=height,
        cursor=cursor,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    format_: DesktopScreenshotFormat | Unset = UNSET,
    quality: int | Unset = UNSET,
    max_width: int | Unset = UNSET,
    max_height: int | Unset = UNSET,
    x: int | None | Unset = UNSET,
    y: int | None | Unset = UNSET,
    width: int | Unset = UNSET,
    height: int | Unset = UNSET,
    cursor: DesktopScreenshotCursor | Unset = UNSET,
) -> Response[Error]:
    """Capture the desktop

     PNG or JPEG screen capture independent of the video streamer, with original screen, image and cursor
    metadata in response headers.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        format_ (DesktopScreenshotFormat | Unset):
        quality (int | Unset):
        max_width (int | Unset):
        max_height (int | Unset):
        x (int | None | Unset):
        y (int | None | Unset):
        width (int | Unset):
        height (int | Unset):
        cursor (DesktopScreenshotCursor | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        format_=format_,
        quality=quality,
        max_width=max_width,
        max_height=max_height,
        x=x,
        y=y,
        width=width,
        height=height,
        cursor=cursor,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    format_: DesktopScreenshotFormat | Unset = UNSET,
    quality: int | Unset = UNSET,
    max_width: int | Unset = UNSET,
    max_height: int | Unset = UNSET,
    x: int | None | Unset = UNSET,
    y: int | None | Unset = UNSET,
    width: int | Unset = UNSET,
    height: int | Unset = UNSET,
    cursor: DesktopScreenshotCursor | Unset = UNSET,
) -> Error | None:
    """Capture the desktop

     PNG or JPEG screen capture independent of the video streamer, with original screen, image and cursor
    metadata in response headers.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        format_ (DesktopScreenshotFormat | Unset):
        quality (int | Unset):
        max_width (int | Unset):
        max_height (int | Unset):
        x (int | None | Unset):
        y (int | None | Unset):
        width (int | Unset):
        height (int | Unset):
        cursor (DesktopScreenshotCursor | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            format_=format_,
            quality=quality,
            max_width=max_width,
            max_height=max_height,
            x=x,
            y=y,
            width=width,
            height=height,
            cursor=cursor,
        )
    ).parsed
