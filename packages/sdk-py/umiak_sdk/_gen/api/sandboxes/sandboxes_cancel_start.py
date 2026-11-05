from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox_action import SandboxAction
from ...types import Response


def _get_kwargs(
    sandbox: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/cancel-start".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxAction:
    if response.status_code == 202:
        response_202 = SandboxAction.from_dict(response.json())

        return response_202

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
) -> Response[Error | SandboxAction]:
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
) -> Response[Error | SandboxAction]:
    """Cancel a queued start

     Cancels only an unadmitted capacity wait. Idempotent; an admitted or moving start must be
    stopped/deleted through its normal lifecycle.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> Error | SandboxAction | None:
    """Cancel a queued start

     Cancels only an unadmitted capacity wait. Idempotent; an admitted or moving start must be
    stopped/deleted through its normal lifecycle.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxAction
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | SandboxAction]:
    """Cancel a queued start

     Cancels only an unadmitted capacity wait. Idempotent; an admitted or moving start must be
    stopped/deleted through its normal lifecycle.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
) -> Error | SandboxAction | None:
    """Cancel a queued start

     Cancels only an unadmitted capacity wait. Idempotent; an admitted or moving start must be
    stopped/deleted through its normal lifecycle.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxAction
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
        )
    ).parsed
