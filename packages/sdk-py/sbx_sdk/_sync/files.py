# Generated from sbx_sdk/_async/files.py by scripts/gen.py; do not edit.
"""Files of a sandbox (S7 §11.1, §15.4).

- read_text/read_bytes and write_text/write_bytes: GET/PUT /files/content.
- upload: resumable chunked upload (4 MiB chunks by default). A chunk whose
  answer was lost shows up as 409 upload_offset_mismatch and is skipped; a
  failed chunk is resumed from the offset of HEAD .../uploads/{id}. The
  sha256 of the whole file is sent on commit.
- download: streams to a local path or a binary file object, resuming after
  a break with Range + If-Range (a changed file restarts a local path).

Paths are absolute or relative to the home directory of ``user``.
Directory archives (upload_dir/download_dir) are not in the Python SDK yet.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
from collections.abc import Callable, Iterator
from typing import IO, TYPE_CHECKING, Any

import httpx

from .._errors import SbxError, broken
from .._events import DownloadResult
from .._gen.api.files import (
    files_chmod,
    files_commit_upload,
    files_create_upload,
    files_delete,
    files_download,
    files_list,
    files_mkdir,
    files_move,
    files_put_chunk,
    files_stat,
    files_upload_offset,
    files_write,
)
from .._gen.models.file_info import FileInfo
from .._gen.models.file_remove_result import FileRemoveResult
from .._gen.models.files_delete_recursive import FilesDeleteRecursive
from .._gen.models.files_list_include_hidden import FilesListIncludeHidden
from .._gen.models.files_stat_no_follow import FilesStatNoFollow
from .._gen.models.files_write_make_parents import FilesWriteMakeParents
from .._gen.models.files_write_overwrite import FilesWriteOverwrite
from .._gen.types import UNSET, File
from .._retry import MAX_FAILURES, is_retryable, retry_delay
from ._io import sleep
from .client import body_of

if TYPE_CHECKING:
    from .sandbox import Sandbox

_NETWORK_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)

#: What ``upload`` reads: bytes, a local path, or a binary file object.
UploadSource = bytes | bytearray | memoryview | str | os.PathLike[str] | IO[bytes]
#: Where ``download`` writes: a local path or a binary file object.
DownloadTarget = str | os.PathLike[str] | IO[bytes]


def _bool(v: bool) -> str:
    return "true" if v else "false"


def _opt(v: Any) -> Any:
    return UNSET if v is None else v


class Files:
    def __init__(self, sandbox: Sandbox) -> None:
        self._sb = sandbox

    def read_bytes(
        self, path: str, *, user: str | None = None, retry_budget: float | None = None
    ) -> bytes:
        resp = self._sb.core.send(
            files_download._get_kwargs(self._sb.id, path=path, user=_opt(user)),
            retry_budget=retry_budget,
        )
        return resp.content

    def read_text(
        self, path: str, *, user: str | None = None, retry_budget: float | None = None
    ) -> str:
        return (self.read_bytes(path, user=user, retry_budget=retry_budget)).decode("utf-8")

    def write_bytes(
        self,
        path: str,
        data: bytes | str,
        *,
        mode: int | None = None,
        make_parents: bool = True,
        overwrite: bool = True,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        """Atomic write of the whole file (PUT /files/content); retried as a whole.
        ``mode``: permission bits, e.g. 0o644."""
        payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        return self._sb.core.call(
            files_write,
            self._sb.id,
            # bytes, not a file object: httpx can send bytes again on a retry.
            body=File(payload=payload),  # type: ignore[arg-type]
            path=path,
            user=_opt(user),
            mode=UNSET if mode is None else format(mode, "o"),
            make_parents=FilesWriteMakeParents(_bool(make_parents)),
            overwrite=FilesWriteOverwrite(_bool(overwrite)),
            retry_budget=retry_budget,
        )

    def write_text(
        self,
        path: str,
        text: str,
        *,
        mode: int | None = None,
        make_parents: bool = True,
        overwrite: bool = True,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        return self.write_bytes(
            path,
            text,
            mode=mode,
            make_parents=make_parents,
            overwrite=overwrite,
            user=user,
            retry_budget=retry_budget,
        )

    def stat(
        self,
        path: str,
        *,
        no_follow: bool | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        return self._sb.core.call(
            files_stat,
            self._sb.id,
            path=path,
            user=_opt(user),
            no_follow=UNSET if no_follow is None else FilesStatNoFollow(_bool(no_follow)),
            retry_budget=retry_budget,
        )

    def list(
        self,
        path: str,
        *,
        depth: int | None = None,
        include_hidden: bool | None = None,
        limit: int | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> Iterator[FileInfo]:
        """Entries of a directory, all pages (``depth`` 1-8, hidden files included by default)."""
        cursor: str | None = None
        while True:
            page = self._sb.core.call(
                files_list,
                self._sb.id,
                path=path,
                user=_opt(user),
                depth=_opt(depth),
                include_hidden=(
                    UNSET
                    if include_hidden is None
                    else FilesListIncludeHidden(_bool(include_hidden))
                ),
                limit=_opt(limit),
                cursor=_opt(cursor),
                retry_budget=retry_budget,
            )
            for entry in page.data:
                yield entry
            cursor = page.next_cursor
            if not cursor:
                return

    def mkdir(
        self,
        path: str,
        *,
        parents: bool | None = None,
        mode: int | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        body: dict[str, Any] = {"path": path}
        if parents is not None:
            body["parents"] = parents
        if mode is not None:
            body["mode"] = mode
        return self._sb.core.call(
            files_mkdir, self._sb.id, body=body_of(body), user=_opt(user), retry_budget=retry_budget
        )

    def move(
        self,
        src: str,
        dst: str,
        *,
        overwrite: bool | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        body: dict[str, Any] = {"from": src, "to": dst}
        if overwrite is not None:
            body["overwrite"] = overwrite
        return self._sb.core.call(
            files_move, self._sb.id, body=body_of(body), user=_opt(user), retry_budget=retry_budget
        )

    def chmod(
        self,
        path: str,
        *,
        mode: int | None = None,
        owner: str | None = None,
        group: str | None = None,
        recursive: bool | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        body: dict[str, Any] = {"path": path}
        for k, v in (("mode", mode), ("owner", owner), ("group", group), ("recursive", recursive)):
            if v is not None:
                body[k] = v
        return self._sb.core.call(
            files_chmod, self._sb.id, body=body_of(body), user=_opt(user), retry_budget=retry_budget
        )

    def remove(
        self,
        path: str,
        *,
        recursive: bool | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileRemoveResult:
        """Deletes a file or directory; ``existed`` is False when there was nothing."""
        return self._sb.core.call(
            files_delete,
            self._sb.id,
            path=path,
            user=_opt(user),
            recursive=UNSET if recursive is None else FilesDeleteRecursive(_bool(recursive)),
            retry_budget=retry_budget,
        )

    def upload(
        self,
        path: str,
        src: UploadSource,
        *,
        chunk_size: int | None = None,
        mode: int | None = None,
        overwrite: bool | None = None,
        make_parents: bool | None = None,
        on_progress: Callable[[int], Any] | None = None,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> FileInfo:
        """Resumable chunked upload (S7 §11.1); returns the committed file.
        ``chunk_size``: default the api's (4 MiB), at most its maximum.
        ``on_progress`` gets the bytes acknowledged so far after each chunk."""
        restarts = 0
        while True:
            source = _open_source(src)
            try:
                info = self._upload_once(
                    path,
                    source,
                    chunk_size=chunk_size,
                    mode=mode,
                    overwrite=overwrite,
                    make_parents=make_parents,
                    on_progress=on_progress,
                    user=user,
                    retry_budget=retry_budget,
                )
            finally:
                source.close()
            if info is not None:
                return info
            # The agent lost the upload: start again from the first byte.
            restarts += 1
            if restarts >= MAX_FAILURES:
                raise _mismatch(f"the agent lost the upload {restarts} times", 0)
            sleep(retry_delay(None, restarts - 1, self._sb.core.random))

    def _upload_once(
        self,
        path: str,
        source: _Source,
        *,
        chunk_size: int | None,
        mode: int | None,
        overwrite: bool | None,
        make_parents: bool | None,
        on_progress: Callable[[int], Any] | None,
        user: str | None,
        retry_budget: float | None,
    ) -> FileInfo | None:
        """One upload session; None when the agent lost it (a seekable source restarts)."""
        core = self._sb.core
        up = core.call(
            files_create_upload,
            self._sb.id,
            body=body_of({"path": path}),
            retry_budget=retry_budget,
        )
        size = max(1, min(chunk_size or up.chunk_size_bytes, up.max_chunk_size_bytes))
        digest = hashlib.sha256()
        acked = 0
        chunk: bytes | None = None
        chunk_start = 0
        sent_any = False
        failures = 0
        while True:
            if chunk is None:
                chunk = source.read(acked, size)
                chunk_start = acked
                # An empty first chunk still creates the (empty) upload.
                if not chunk and sent_any:
                    break
            counted = False  # this round's failure was counted (and waited for) already
            try:
                resp = core.send(
                    files_put_chunk._get_kwargs(
                        self._sb.id,
                        up.upload_id,
                        body=File(payload=chunk),  # type: ignore[arg-type]
                        offset=chunk_start,
                        path=path,
                        user=_opt(user),
                    ),
                    retry_budget=retry_budget,
                )
                server = _upload_offset(resp)
            except SbxError as err:
                mismatch = _mismatch_offset(err)
                if mismatch is None:
                    # A chunk PUT is safe to repeat (the offset guards it).
                    if not is_retryable(err, True):
                        raise
                    failures += 1
                    counted = True
                    if failures >= MAX_FAILURES:
                        raise
                    sleep(retry_delay(err, failures - 1, core.random))
                    known = self._head_offset(up.upload_id, retry_budget)
                    if known is None:
                        continue  # repeat the same chunk
                    server = known
                else:
                    server = mismatch
            sent_any = True
            end = chunk_start + len(chunk)
            if server == end:
                digest.update(chunk)
                acked = end
                chunk = None
                failures = 0
            elif chunk_start < server < end:
                # Part of the chunk arrived: send the rest.
                done = server - chunk_start
                digest.update(chunk[:done])
                chunk = chunk[done:]
                chunk_start = server
                acked = server
                failures = 0
            elif server == chunk_start:
                # Nothing of the chunk arrived; repeat it after a backoff.
                if not counted:
                    failures += 1
                    if failures >= MAX_FAILURES:
                        raise _mismatch(
                            f"the upload stays at {server} after {failures} attempts", server
                        )
                    sleep(retry_delay(None, failures - 1, core.random))
            elif server == 0 and source.seekable:
                return None
            else:
                raise _mismatch(f"the upload is at {server}, this client at {chunk_start}", server)
            if on_progress is not None:
                on_progress(acked)
        body: dict[str, Any] = {"path": path, "sha256": digest.hexdigest()}
        if mode is not None:
            body["mode"] = mode
        if overwrite is not None:
            body["overwrite"] = overwrite
        if make_parents is not None:
            body["makeParents"] = make_parents
        return core.call(
            files_commit_upload,
            self._sb.id,
            up.upload_id,
            body=body_of(body),
            user=_opt(user),
            retry_budget=retry_budget,
            # Commit is idempotent by uploadId: safe to repeat after a lost answer.
            idempotency_key=up.upload_id,
        )

    def _head_offset(self, upload_id: str, retry_budget: float | None) -> int | None:
        """Sbx-Upload-Offset of HEAD; 0 when the agent has no upload; None when unknown."""
        try:
            resp = self._sb.core.send(
                files_upload_offset._get_kwargs(self._sb.id, upload_id),
                retry_budget=retry_budget,
            )
        except SbxError as err:
            if err.status == 404:
                return 0
            if is_retryable(err, True):
                return None
            raise
        return _upload_offset(resp)

    def download(
        self,
        path: str,
        dest: DownloadTarget,
        *,
        user: str | None = None,
        retry_budget: float | None = None,
    ) -> DownloadResult:
        """Downloads to a local path or a binary file object. A break is resumed
        with Range + If-Range; if the file changed meanwhile, a local path starts
        again and a file object fails with ``file_changed``."""
        core = self._sb.core
        sink = _open_sink(dest)
        ok = False
        try:
            received = 0
            total: int | None = None
            etag: str | None = None
            failures = 0
            while True:
                headers = {"Accept-Encoding": "identity"}
                if received > 0:
                    headers["Range"] = f"bytes={received}-"
                    if etag is not None:
                        headers["If-Range"] = etag
                before = received
                last_error: SbxError
                try:
                    with core.stream(
                        files_download._get_kwargs(self._sb.id, path=path, user=_opt(user)),
                        headers=headers,
                        retry_budget=retry_budget,
                    ) as resp:
                        if received > 0 and (
                            resp.status_code != 206 or _range_start(resp) != received
                        ):
                            # The file changed (If-Range did not match), or the range is
                            # not the one asked for: start again from the first byte.
                            sink.reset()
                            received = 0
                            if resp.status_code == 206:
                                etag = None
                                total = None
                                continue
                        etag = resp.headers.get("ETag") or etag
                        size = _total_size(resp)
                        total = size if size is not None else total
                        for piece in resp.iter_bytes():
                            sink.write(piece)
                            received += len(piece)
                    if total is None or received >= total:
                        ok = True
                        return DownloadResult(size_bytes=received, etag=etag)
                    last_error = broken("the download ended early")
                except _NETWORK_ERRORS as err:
                    last_error = broken(f"the download broke: {err or type(err).__name__}")
                    last_error.__cause__ = err
                except SbxError as err:
                    if (
                        err.code == "range_not_satisfiable"
                        and total is not None
                        and received >= total
                    ):
                        ok = True
                        return DownloadResult(size_bytes=received, etag=etag)
                    if not is_retryable(err, True):
                        raise
                    last_error = err
                failures = 0 if received > before else failures + 1
                if failures >= MAX_FAILURES:
                    raise last_error
                sleep(retry_delay(last_error, max(0, failures - 1), core.random))
        finally:
            sink.close(ok)


def _mismatch(message: str, offset: int) -> SbxError:
    return SbxError(
        status=0,
        code="upload_offset_mismatch",
        message=message,
        retryable=False,
        details={"offset": offset},
    )


def _upload_offset(resp: httpx.Response) -> int:
    h = resp.headers.get("Sbx-Upload-Offset")
    try:
        if h is not None:
            return int(h)
        return int(resp.json()["offset"])
    except (ValueError, KeyError, TypeError):
        raise SbxError(
            status=resp.status_code,
            code="unexpected_response",
            message="the upload answer has no offset",
            retryable=False,
            request_id=resp.headers.get("Request-Id"),
        ) from None


def _mismatch_offset(err: SbxError) -> int | None:
    """The current upload size from a 409 upload_offset_mismatch, else None."""
    if err.code != "upload_offset_mismatch":
        return None
    v = err.details.get("offset")
    return v if isinstance(v, int) else None


def _range_start(resp: httpx.Response) -> int | None:
    """First byte of a 206 answer (``Content-Range: bytes N-M/T``), else None."""
    r = resp.headers.get("Content-Range", "")
    if not r.startswith("bytes "):
        return None
    first = r[6:].split("-", 1)[0]
    return int(first) if first.isdigit() else None


def _total_size(resp: httpx.Response) -> int | None:
    """Size of the whole file from Content-Range (206) or Content-Length (200)."""
    r = resp.headers.get("Content-Range")
    if r is not None and "/" in r:
        tail = r.rsplit("/", 1)[1]
        if tail.isdigit():
            return int(tail)
    if resp.status_code != 200:
        return None
    n = resp.headers.get("Content-Length")
    return int(n) if n is not None and n.isdigit() else None


class _Source:
    """Bytes read by offset; ``seekable`` sources can start again from 0."""

    def __init__(
        self, read: Callable[[int, int], bytes], seekable: bool, close: Callable[[], None]
    ):
        self.read = read
        self.seekable = seekable
        self.close = close


def _open_source(src: UploadSource) -> _Source:
    if isinstance(src, bytes | bytearray | memoryview):
        view = memoryview(src).cast("B")
        return _Source(lambda o, n: bytes(view[o : o + n]), True, lambda: None)
    if isinstance(src, str | os.PathLike):
        f = open(src, "rb")  # closed by _Source.close
        return _Source(_file_reader(f, True), True, f.close)
    seekable = bool(getattr(src, "seekable", lambda: False)())
    return _Source(_file_reader(src, seekable), seekable, lambda: None)


def _file_reader(f: IO[bytes], seekable: bool) -> Callable[[int, int], bytes]:
    pos = 0

    def read(offset: int, n: int) -> bytes:
        nonlocal pos
        if seekable:
            f.seek(offset)
        elif offset != pos:
            raise _mismatch("a stream source cannot go back", offset)
        parts: list[bytes] = []
        got = 0
        while got < n:
            b = f.read(n - got)
            if not b:
                break
            parts.append(b)
            got += len(b)
        pos = offset + got
        return b"".join(parts)

    return read


class _Sink:
    """A local path is written to ``<dest>.tmp`` and renamed at the end, so a
    failed download leaves an existing ``dest`` as it was."""

    def __init__(self, dest: DownloadTarget) -> None:
        self._own = isinstance(dest, str | os.PathLike)
        self._dest = os.fspath(dest) if self._own else ""  # type: ignore[arg-type]
        self._tmp = f"{self._dest}.tmp"
        self._f: IO[bytes] = open(self._tmp, "wb") if self._own else dest  # type: ignore[arg-type]
        self._wrote = False

    def write(self, b: bytes) -> None:
        self._wrote = True
        self._f.write(b)

    def reset(self) -> None:
        """Drops what was written (the file changed); a file object cannot."""
        if self._own:
            self._f.seek(0)
            self._f.truncate(0)
        elif self._wrote:
            raise SbxError(
                status=0,
                code="file_changed",
                message="the file changed during the download",
                retryable=False,
            )

    def close(self, ok: bool) -> None:
        if self._own:
            self._f.close()
            if ok:
                os.replace(self._tmp, self._dest)
            else:
                with contextlib.suppress(FileNotFoundError):
                    os.remove(self._tmp)
        else:
            self._f.flush()


def _open_sink(dest: DownloadTarget) -> _Sink:
    return _Sink(dest)
