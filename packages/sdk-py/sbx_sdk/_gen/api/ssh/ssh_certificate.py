from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.ssh_certificate import SshCertificate
from ...models.ssh_certificate_request import SshCertificateRequest
from ...types import Response


def _get_kwargs(
    sandbox: str,
    *,
    body: SshCertificateRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/ssh/certificate".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SshCertificate:
    if response.status_code == 200:
        response_200 = SshCertificate.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 500:
        response_500 = Error.from_dict(response.json())

        return response_500

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SshCertificate]:
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
    body: SshCertificateRequest,
) -> Response[Error | SshCertificate]:
    """Get a short-lived SSH certificate

     Signs the public key with the platform's SSH login CA: an OpenSSH user certificate for this sandbox
    only, valid 10 minutes (checked when logging in; the session may last longer), with the caller as
    KeyId. Works for people and team keys; the sandbox may be in any state. Every login is still
    checked, so revoking a key or leaving the team takes effect at once.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (SshCertificateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SshCertificate]
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
    body: SshCertificateRequest,
) -> Error | SshCertificate | None:
    """Get a short-lived SSH certificate

     Signs the public key with the platform's SSH login CA: an OpenSSH user certificate for this sandbox
    only, valid 10 minutes (checked when logging in; the session may last longer), with the caller as
    KeyId. Works for people and team keys; the sandbox may be in any state. Every login is still
    checked, so revoking a key or leaving the team takes effect at once.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (SshCertificateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SshCertificate
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
    body: SshCertificateRequest,
) -> Response[Error | SshCertificate]:
    """Get a short-lived SSH certificate

     Signs the public key with the platform's SSH login CA: an OpenSSH user certificate for this sandbox
    only, valid 10 minutes (checked when logging in; the session may last longer), with the caller as
    KeyId. Works for people and team keys; the sandbox may be in any state. Every login is still
    checked, so revoking a key or leaving the team takes effect at once.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (SshCertificateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SshCertificate]
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
    body: SshCertificateRequest,
) -> Error | SshCertificate | None:
    """Get a short-lived SSH certificate

     Signs the public key with the platform's SSH login CA: an OpenSSH user certificate for this sandbox
    only, valid 10 minutes (checked when logging in; the session may last longer), with the caller as
    KeyId. Works for people and team keys; the sandbox may be in any state. Every login is still
    checked, so revoking a key or leaving the team takes effect at once.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (SshCertificateRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SshCertificate
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
