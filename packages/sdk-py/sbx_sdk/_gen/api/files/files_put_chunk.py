from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.upload_offset import UploadOffset
from ...types import UNSET, File, Response, Unset


def _get_kwargs(
    sandbox: str,
    upload: str,
    *,
    body: File | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    path: str | Unset = UNSET,
    user: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    params: dict[str, Any] = {}

    json_offset: int | None | Unset
    if isinstance(offset, Unset):
        json_offset = UNSET
    else:
        json_offset = offset
    params["offset"] = json_offset

    params["path"] = path

    params["user"] = user

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox}/files/uploads/{upload}".format(
            sandbox=quote(str(sandbox), safe=""),
            upload=quote(str(upload), safe=""),
        ),
        "params": params,
    }

    if not isinstance(body, Unset):
        _kwargs["content"] = body.payload
    headers["Content-Type"] = "application/octet-stream"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | UploadOffset:
    if response.status_code == 200:
        response_200 = UploadOffset.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 413:
        response_413 = Error.from_dict(response.json())

        return response_413

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | UploadOffset]:
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
    body: File | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    path: str | Unset = UNSET,
    user: str | Unset = UNSET,
) -> Response[Error | UploadOffset]:
    """Upload a chunk

     Appends the body (up to 8 MiB, any content type) at `offset`. Send the destination as `path` too: it
    tells the sandbox where to keep the partial file. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Sbx-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Sbx-Upload-Offset, details.offset): continue
    from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Must equal the bytes received so far (HEAD gives it)
        path (str | Unset): The destination from POST (a hint where the agent keeps the partial
            file) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | UploadOffset]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
        body=body,
        offset=offset,
        path=path,
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
    body: File | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    path: str | Unset = UNSET,
    user: str | Unset = UNSET,
) -> Error | UploadOffset | None:
    """Upload a chunk

     Appends the body (up to 8 MiB, any content type) at `offset`. Send the destination as `path` too: it
    tells the sandbox where to keep the partial file. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Sbx-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Sbx-Upload-Offset, details.offset): continue
    from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Must equal the bytes received so far (HEAD gives it)
        path (str | Unset): The destination from POST (a hint where the agent keeps the partial
            file) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | UploadOffset
    """

    return sync_detailed(
        sandbox=sandbox,
        upload=upload,
        client=client,
        body=body,
        offset=offset,
        path=path,
        user=user,
    ).parsed


async def asyncio_detailed(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    path: str | Unset = UNSET,
    user: str | Unset = UNSET,
) -> Response[Error | UploadOffset]:
    """Upload a chunk

     Appends the body (up to 8 MiB, any content type) at `offset`. Send the destination as `path` too: it
    tells the sandbox where to keep the partial file. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Sbx-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Sbx-Upload-Offset, details.offset): continue
    from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Must equal the bytes received so far (HEAD gives it)
        path (str | Unset): The destination from POST (a hint where the agent keeps the partial
            file) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | UploadOffset]
    """

    kwargs = _get_kwargs(
        sandbox=sandbox,
        upload=upload,
        body=body,
        offset=offset,
        path=path,
        user=user,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox: str,
    upload: str,
    *,
    client: AuthenticatedClient | Client,
    body: File | Unset = UNSET,
    offset: int | None | Unset = UNSET,
    path: str | Unset = UNSET,
    user: str | Unset = UNSET,
) -> Error | UploadOffset | None:
    """Upload a chunk

     Appends the body (up to 8 MiB, any content type) at `offset`. Send the destination as `path` too: it
    tells the sandbox where to keep the partial file. Flow: POST .../uploads {path} → PUT
    .../uploads/{upload}?offset=N&path= (chunks up to 8 MiB, offset = bytes so far) → POST
    .../uploads/{upload}/commit {path, sha256}. After a break, HEAD .../uploads/{upload} gives Sbx-
    Upload-Offset to resume from. A chunk whose offset is not the current size is 409
    upload_offset_mismatch with the current offset (header Sbx-Upload-Offset, details.offset): continue
    from there.

    Args:
        sandbox (str): Sandbox id (`sb_...`) or slug Example: quiet-otter-lamp.
        upload (str): Upload id (`upl_...`) from POST .../files/uploads Example:
            upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
        offset (int | None | Unset): Must equal the bytes received so far (HEAD gives it)
        path (str | Unset): The destination from POST (a hint where the agent keeps the partial
            file) Example: src/app.py.
        user (str | Unset): Guest user whose home relative paths start from and who owns new files
            (default `user`)
        body (File | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | UploadOffset
    """

    return (
        await asyncio_detailed(
            sandbox=sandbox,
            upload=upload,
            client=client,
            body=body,
            offset=offset,
            path=path,
            user=user,
        )
    ).parsed
