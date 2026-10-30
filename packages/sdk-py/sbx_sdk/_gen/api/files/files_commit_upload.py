from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.commit_upload_request import CommitUploadRequest
from ...models.error import Error
from ...models.file_info import FileInfo
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox: str,
    upload: str,
    *,
    body: CommitUploadRequest,
    user: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    params: dict[str, Any] = {}

    params["user"] = user

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox}/files/uploads/{upload}/commit".format(
            sandbox=quote(str(sandbox), safe=""),
            upload=quote(str(upload), safe=""),
        ),
        "params": params,
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | FileInfo:
    if response.status_code == 200:
        response_200 = FileInfo.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Error.from_dict(response.json())

        return response_422

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | FileInfo]:
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
    body: CommitUploadRequest,
    user: str | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Finish an upload

     Moves the uploaded bytes to `path`. Idempotent by upload id: a repeat returns the same FileInfo (24
    h). A `sha256` that does not match is 422 checksum_mismatch and the upload is dropped (start over).
    Flow: POST .../uploads {path} → PUT .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset
    = bytes so far) → POST .../uploads/{upload}/commit {path, sha256}. After a break, HEAD
    .../uploads/{upload} gives Sbx-Upload-Offset to resume from. A chunk whose offset is not the current
    size is 409 upload_offset_mismatch with the current offset (header Sbx-Upload-Offset,
    details.offset): continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (CommitUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
        body=body,
        user=user,
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
    body: CommitUploadRequest,
    user: str | Unset = UNSET,
) -> Error | FileInfo | None:
    """Finish an upload

     Moves the uploaded bytes to `path`. Idempotent by upload id: a repeat returns the same FileInfo (24
    h). A `sha256` that does not match is 422 checksum_mismatch and the upload is dropped (start over).
    Flow: POST .../uploads {path} → PUT .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset
    = bytes so far) → POST .../uploads/{upload}/commit {path, sha256}. After a break, HEAD
    .../uploads/{upload} gives Sbx-Upload-Offset to resume from. A chunk whose offset is not the current
    size is 409 upload_offset_mismatch with the current offset (header Sbx-Upload-Offset,
    details.offset): continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (CommitUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileInfo
    """

    return sync_detailed(
        sandbox=sandbox,
        upload=upload,
        client=client,
        body=body,
        user=user,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommitUploadRequest,
    user: str | Unset = UNSET,
) -> Response[Error | FileInfo]:
    """Finish an upload

     Moves the uploaded bytes to `path`. Idempotent by upload id: a repeat returns the same FileInfo (24
    h). A `sha256` that does not match is 422 checksum_mismatch and the upload is dropped (start over).
    Flow: POST .../uploads {path} → PUT .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset
    = bytes so far) → POST .../uploads/{upload}/commit {path, sha256}. After a break, HEAD
    .../uploads/{upload} gives Sbx-Upload-Offset to resume from. A chunk whose offset is not the current
    size is 409 upload_offset_mismatch with the current offset (header Sbx-Upload-Offset,
    details.offset): continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (CommitUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | FileInfo]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
        body=body,
        user=user,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
    body: CommitUploadRequest,
    user: str | Unset = UNSET,
) -> Error | FileInfo | None:
    """Finish an upload

     Moves the uploaded bytes to `path`. Idempotent by upload id: a repeat returns the same FileInfo (24
    h). A `sha256` that does not match is 422 checksum_mismatch and the upload is dropped (start over).
    Flow: POST .../uploads {path} → PUT .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset
    = bytes so far) → POST .../uploads/{upload}/commit {path, sha256}. After a break, HEAD
    .../uploads/{upload} gives Sbx-Upload-Offset to resume from. A chunk whose offset is not the current
    size is 409 upload_offset_mismatch with the current offset (header Sbx-Upload-Offset,
    details.offset): continue from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (CommitUploadRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | FileInfo
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            upload=upload,
            client=client,
            body=body,
            user=user,
        )
    ).parsed
