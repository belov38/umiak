from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox import Sandbox
from ...models.unblock_request import UnblockRequest
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: UnblockRequest | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/unblock".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Sandbox:
    if response.status_code == 200:
        response_200 = Sandbox.from_dict(response.json())

        return response_200

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | Sandbox]:
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
    body: UnblockRequest | Unset = UNSET,
) -> Response[Error | Sandbox]:
    """Unblock a sandbox (operator)

     Lifts the block at once; on a sandbox that is not blocked nothing changes. Only a platform
    operator's browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden`
    (details.reason `operator_required`). The sandbox is found in any team, no Sbx-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UnblockRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: UnblockRequest | Unset = UNSET,
) -> Error | Sandbox | None:
    """Unblock a sandbox (operator)

     Lifts the block at once; on a sandbox that is not blocked nothing changes. Only a platform
    operator's browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden`
    (details.reason `operator_required`). The sandbox is found in any team, no Sbx-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UnblockRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
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
    body: UnblockRequest | Unset = UNSET,
) -> Response[Error | Sandbox]:
    """Unblock a sandbox (operator)

     Lifts the block at once; on a sandbox that is not blocked nothing changes. Only a platform
    operator's browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden`
    (details.reason `operator_required`). The sandbox is found in any team, no Sbx-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UnblockRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: UnblockRequest | Unset = UNSET,
) -> Error | Sandbox | None:
    """Unblock a sandbox (operator)

     Lifts the block at once; on a sandbox that is not blocked nothing changes. Only a platform
    operator's browser session (the dashboard); API keys and Keycloak tokens are 403 `forbidden`
    (details.reason `operator_required`). The sandbox is found in any team, no Sbx-Team needed.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (UnblockRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
