from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.create_upload_request import CreateUploadRequest
from ...models.error import Error
from ...models.upload import Upload
from ...types import Response


def _get_kwargs(
    sandbox: str,
    *,
    body: CreateUploadRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/files/uploads".format(
            sandbox=quote(str(sandbox), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Upload:
    if response.status_code == 201:
        response_201 = Upload.from_dict(response.json())

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
) -> Response[Error | Upload]:
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
    body: CreateUploadRequest,
) -> Response[Error | Upload]:
    """Start a resumable upload

     Starts a resumable upload of a large file. Nothing is stored by the api; the partial file lives in
    the sandbox and is dropped after 24 h without activity. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Umiak-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Umiak-Upload-Offset, details.offset):
    continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (CreateUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Upload]
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
    body: CreateUploadRequest,
) -> Error | Upload | None:
    """Start a resumable upload

     Starts a resumable upload of a large file. Nothing is stored by the api; the partial file lives in
    the sandbox and is dropped after 24 h without activity. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Umiak-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Umiak-Upload-Offset, details.offset):
    continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (CreateUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Upload
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
    body: CreateUploadRequest,
) -> Response[Error | Upload]:
    """Start a resumable upload

     Starts a resumable upload of a large file. Nothing is stored by the api; the partial file lives in
    the sandbox and is dropped after 24 h without activity. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Umiak-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Umiak-Upload-Offset, details.offset):
    continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (CreateUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Upload]
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
    body: CreateUploadRequest,
) -> Error | Upload | None:
    """Start a resumable upload

     Starts a resumable upload of a large file. Nothing is stored by the api; the partial file lives in
    the sandbox and is dropped after 24 h without activity. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Umiak-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Umiak-Upload-Offset, details.offset):
    continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        body (CreateUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Upload
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            client=client,
            body=body,
        )
    ).parsed
