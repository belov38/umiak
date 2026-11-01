from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.resume_sandbox_request import ResumeSandboxRequest
from ...models.sandbox_action import SandboxAction
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    *,
    body: ResumeSandboxRequest | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/resume".format(
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
) -> Error | SandboxAction:
    if response.status_code == 202:
        response_202 = SandboxAction.from_dict(response.json())

        return response_202

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

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
    body: ResumeSandboxRequest | Unset = UNSET,
) -> Response[Error | SandboxAction]:
    """Resume a stopped sandbox

     Starts a stopped sandbox again, optionally with another size or TTL. env, secrets and secretFiles
    merge onto the sandbox's own (null deletes) and are kept even if the resume fails. A repeat with the
    same body while the resume runs returns it.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (ResumeSandboxRequest | Unset): Sets merge onto the sandbox's own and are stored even
            if the resume fails

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
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
    body: ResumeSandboxRequest | Unset = UNSET,
) -> Error | SandboxAction | None:
    """Resume a stopped sandbox

     Starts a stopped sandbox again, optionally with another size or TTL. env, secrets and secretFiles
    merge onto the sandbox's own (null deletes) and are kept even if the resume fails. A repeat with the
    same body while the resume runs returns it.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (ResumeSandboxRequest | Unset): Sets merge onto the sandbox's own and are stored even
            if the resume fails

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxAction
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
    body: ResumeSandboxRequest | Unset = UNSET,
) -> Response[Error | SandboxAction]:
    """Resume a stopped sandbox

     Starts a stopped sandbox again, optionally with another size or TTL. env, secrets and secretFiles
    merge onto the sandbox's own (null deletes) and are kept even if the resume fails. A repeat with the
    same body while the resume runs returns it.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (ResumeSandboxRequest | Unset): Sets merge onto the sandbox's own and are stored even
            if the resume fails

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxAction]
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
    body: ResumeSandboxRequest | Unset = UNSET,
) -> Error | SandboxAction | None:
    """Resume a stopped sandbox

     Starts a stopped sandbox again, optionally with another size or TTL. env, secrets and secretFiles
    merge onto the sandbox's own (null deletes) and are kept even if the resume fails. A repeat with the
    same body while the resume runs returns it.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (ResumeSandboxRequest | Unset): Sets merge onto the sandbox's own and are stored even
            if the resume fails

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
            body=body,
        )
    ).parsed
