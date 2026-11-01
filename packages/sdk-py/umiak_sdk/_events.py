"""Results of the facade helpers that are not API resources: command events,
exec results, output chunks, downloads. API resources are the generated
models of ``umiak_sdk.models``.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Literal

from ._gen.models.command import Command as CommandData

OutputStream = Literal["stdout", "stderr", "pty"]
Encoding = Literal["utf8", "base64"]

#: Tail kept by exec per stream (S7 §9.2).
EXEC_TAIL_BYTES = 4 * 1024 * 1024
#: A command stream with no byte for this long is a dead connection (S7 §9.7).
STREAM_IDLE_TIMEOUT = 45.0
#: Default limit of wait_until_ready (S7 §15.4).
READY_TIMEOUT = 300.0


@dataclass(slots=True)
class Offsets:
    """Byte offsets of the output streams (the next byte to read)."""

    stdout: int = 0
    stderr: int = 0
    pty: int | None = None


@dataclass(frozen=True, slots=True)
class OutputEvent:
    """Output of a stream: ``str`` (whole characters) for utf8, ``bytes`` for base64."""

    type: OutputStream
    data: str | bytes
    #: Offset of the first byte of ``data``.
    offset: int
    next_offset: int


@dataclass(frozen=True, slots=True)
class TruncatedEvent:
    """The agent no longer has the bytes before ``available_from`` (retention)."""

    stream: OutputStream
    available_from: int
    type: Literal["truncated"] = "truncated"


@dataclass(frozen=True, slots=True)
class ExitEvent:
    """The last event: the command ended and all its output was delivered."""

    status: str
    exit_code: int | None
    signal: str | None
    reason: str | None
    stdout_offset: int
    stderr_offset: int
    pty_offset: int | None = None
    #: "disk_full" when the agent dropped output (a full disk); None otherwise.
    output_truncated: str | None = None
    type: Literal["exit"] = "exit"


RunEvent = OutputEvent | TruncatedEvent | ExitEvent


@dataclass(frozen=True, slots=True)
class ExecResult:
    #: The Command resource after the exit.
    command: CommandData
    #: The last 4 MiB of each stream (whole frames).
    stdout: str
    stderr: str
    exit_code: int | None
    #: Earlier output was dropped: read it with ``Command.output``.
    stdout_truncated: bool
    stderr_truncated: bool
    #: Offset of the first byte of ``stdout`` / ``stderr`` in the stream.
    stdout_from: int = 0
    stderr_from: int = 0
    #: "disk_full" when the agent dropped output (a full disk); None otherwise.
    output_truncated: str | None = None


@dataclass(frozen=True, slots=True)
class OutputChunk:
    """Raw bytes of one stream (GET .../output)."""

    data: bytes
    offset: int
    next_offset: int
    available_from: int
    #: Size of the stream once it has ended, else None.
    end: int | None
    #: ``offset`` was below what the agent still has; reading began later.
    truncated: bool


@dataclass(frozen=True, slots=True)
class DownloadResult:
    size_bytes: int
    etag: str | None


class Tail:
    """The last EXEC_TAIL_BYTES of a stream, by whole frames."""

    def __init__(self) -> None:
        self._pieces: deque[tuple[str, int]] = deque()
        self._bytes = 0
        # Stream offset after the last byte seen.
        self._end = 0
        self.truncated = False

    @property
    def start(self) -> int:
        """Offset of the first byte of the tail."""
        return self._end - self._bytes

    def push(self, text: str, next_offset: int) -> None:
        """A frame of ``text`` that ends at stream offset ``next_offset``."""
        size = max(0, next_offset - self._end)
        self._end = next_offset
        self._pieces.append((text, size))
        self._bytes += size
        while self._bytes > EXEC_TAIL_BYTES and len(self._pieces) > 1:
            _, dropped = self._pieces.popleft()
            self._bytes -= dropped
            self.truncated = True

    def drop(self, available_from: int) -> None:
        """Output before a gap is not part of the tail; the stream goes on at
        ``available_from``."""
        self._pieces.clear()
        self._bytes = 0
        self._end = max(self._end, available_from)
        self.truncated = True

    def text(self) -> str:
        return "".join(t for t, _ in self._pieces)
