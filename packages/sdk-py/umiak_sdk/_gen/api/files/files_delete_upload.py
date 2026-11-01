from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...types import Response


def _get_kwargs(
    sandbox: str,
    upload: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/sandboxes/{sandbox}/files/uploads/{upload}".format(
            sandbox=quote(str(sandbox), safe=""),
            upload=quote(str(upload), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | Error:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

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
) -> Response[Any | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Any | Error]:
    """Cancel an upload

     Drops a partial upload. An unknown upload is 404 upload_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
) -> Any | Error | None:
    """Cancel an upload

     Drops a partial upload. An unknown upload is 404 upload_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return sync_detailed(
        sandbox=sandbox,
        upload=upload,
        client=client,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Any | Error]:
    """Cancel an upload

     Drops a partial upload. An unknown upload is 404 upload_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | Error]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
) -> Any | Error | None:
    """Cancel an upload

     Drops a partial upload. An unknown upload is 404 upload_not_found.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | Error
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            upload=upload,
            client=client,
        )
    ).parsed
