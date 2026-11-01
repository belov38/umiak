"""NDJSON decoder of the command streams (S7 §9.5): one JSON object per line.

Bytes are split at ``\\n`` before decoding (a newline byte never occurs inside
a multi-byte UTF-8 character). A line that is not JSON, or a body that ends
inside a line, is a broken stream (``network_error``, retryable): the caller
reopens it from its offsets. Values that are not objects are skipped.
"""

from __future__ import annotations

import json
from typing import Any

from ._errors import broken


class NdjsonDecoder:
    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        """The complete objects of the bytes received so far, in order."""
        buf = self._buf
        buf += chunk
        out: list[dict[str, Any]] = []
        start = 0
        try:
            while (nl := buf.find(b"\n", start)) >= 0:
                line = bytes(buf[start:nl]).strip()
                start = nl + 1
                if not line:
                    continue
                try:
                    v = json.loads(line)
                except ValueError as err:
                    raise broken("stream line is not JSON") from err
                if isinstance(v, dict):
                    out.append(v)
        finally:
            del buf[:start]
        return out

    def end(self) -> None:
        """The body ended: fails if it ended inside a line."""
        if bytes(self._buf).strip():
            raise broken("stream ended inside a line")
