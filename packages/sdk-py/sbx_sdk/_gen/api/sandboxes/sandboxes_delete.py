from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox_delete import SandboxDelete
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    sbx_confirm_delete: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(sbx_confirm_delete, Unset):
        headers["Sbx-Confirm-Delete"] = sbx_confirm_delete

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/sandboxes/{sandbox}".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxDelete:
    if response.status_code == 200:
        response_200 = SandboxDelete.from_dict(response.json())

        return response_200

    if response.status_code == 202:
        response_202 = SandboxDelete.from_dict(response.json())

        return response_202

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 428:
        response_428 = Error.from_dict(response.json())

        return response_428

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxDelete]:
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
    sbx_confirm_delete: str | Unset = UNSET,
) -> Response[Error | SandboxDelete]:
    """Delete a sandbox

     Deletes the sandbox and its VM; any running operation is superseded. Needs the header Sbx-Confirm-
    Delete with the sandbox id (or slug) — otherwise 428 and nothing happens. Answers 202 with the
    delete operation; on an already deleted sandbox 200 with `operation: null`. Repeating is safe.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        sbx_confirm_delete (str | Unset): Required: the id (`sb_...`) or slug of the sandbox in
            the path; without it or with another sandbox the answer is 428 and nothing is deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxDelete]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        sbx_confirm_delete=sbx_confirm_delete,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    sbx_confirm_delete: str | Unset = UNSET,
) -> Error | SandboxDelete | None:
    """Delete a sandbox

     Deletes the sandbox and its VM; any running operation is superseded. Needs the header Sbx-Confirm-
    Delete with the sandbox id (or slug) — otherwise 428 and nothing happens. Answers 202 with the
    delete operation; on an already deleted sandbox 200 with `operation: null`. Repeating is safe.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        sbx_confirm_delete (str | Unset): Required: the id (`sb_...`) or slug of the sandbox in
            the path; without it or with another sandbox the answer is 428 and nothing is deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxDelete
    """

    return sync_detailed(
        sandbox=sandbox,
        client=client,
        sbx_confirm_delete=sbx_confirm_delete,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    sbx_confirm_delete: str | Unset = UNSET,
) -> Response[Error | SandboxDelete]:
    """Delete a sandbox

     Deletes the sandbox and its VM; any running operation is superseded. Needs the header Sbx-Confirm-
    Delete with the sandbox id (or slug) — otherwise 428 and nothing happens. Answers 202 with the
    delete operation; on an already deleted sandbox 200 with `operation: null`. Repeating is safe.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        sbx_confirm_delete (str | Unset): Required: the id (`sb_...`) or slug of the sandbox in
            the path; without it or with another sandbox the answer is 428 and nothing is deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxDelete]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        sbx_confirm_delete=sbx_confirm_delete,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    *,
    client: AuthenticatedClient | Client,
    sbx_confirm_delete: str | Unset = UNSET,
) -> Error | SandboxDelete | None:
    """Delete a sandbox

     Deletes the sandbox and its VM; any running operation is superseded. Needs the header Sbx-Confirm-
    Delete with the sandbox id (or slug) — otherwise 428 and nothing happens. Answers 202 with the
    delete operation; on an already deleted sandbox 200 with `operation: null`. Repeating is safe.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        sbx_confirm_delete (str | Unset): Required: the id (`sb_...`) or slug of the sandbox in
            the path; without it or with another sandbox the answer is 428 and nothing is deleted

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxDelete
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            sbx_confirm_delete=sbx_confirm_delete,
        )
    ).parsed
