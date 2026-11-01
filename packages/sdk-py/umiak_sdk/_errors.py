"""Errors of the SDK. Every API error body is
``{"error": {"code", "message", "retryable", "details", "requestId"}}`` (S7 §5.5).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Mapping
from email.utils import parsedate_to_datetime
from typing import Any

# The request did not reach the API or the connection broke (status 0).
NETWORK_ERROR = "network_error"
# The response is an error without the API envelope (a proxy page, say).
UNEXPECTED_RESPONSE = "unexpected_response"
# No credentials found in the chain (S7 §7.6).
NO_CREDENTIALS = "no_credentials"
# No API URL: neither base_url, UMIAK_API_URL nor an umiak profile.
NO_API_URL = "no_api_url"
# `umiak auth token --json` failed or printed something unexpected.
AUTH_COMMAND_FAILED = "auth_command_failed"
# The token_provider option raised or returned no token.
TOKEN_PROVIDER_FAILED = "token_provider_failed"
# wait_until_ready / wait_for_operation ran out of time.
WAIT_TIMEOUT = "wait_timeout"
# Frames of a command stream that do not fit the offsets (retried by reattach).
PROTOCOL_ERROR = "protocol_error"


class UmiakError(Exception):
    """An API error, or an SDK error with ``status`` 0 (network, credentials, streams)."""

    def __init__(
        self,
        *,
        status: int,
        code: str,
        message: str,
        retryable: bool,
        details: Mapping[str, Any] | None = None,
        request_id: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        #: HTTP status; 0 when there is no response (network, credentials, stream frames).
        self.status = status
        #: Stable snake_case code (S7 §5.5) or one of the SDK codes of this module.
        self.code = code
        self.message = message
        #: A repeat of the same request is safe and may succeed later.
        self.retryable = retryable
        self.details: dict[str, Any] = dict(details or {})
        self.request_id = request_id
        #: Seconds the server asked to wait (Retry-After), if any.
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return (
            f"UmiakError(status={self.status}, code={self.code!r}, message={self.message!r}, "
            f"retryable={self.retryable}, request_id={self.request_id!r})"
        )


class SandboxFailedError(UmiakError):
    """The sandbox became error, deleting, deleted or stopped while waiting for ready."""


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """Retry-After (delta seconds or an HTTP date) in seconds."""
    if value is None or value.strip() == "":
        return None
    v = value.strip()
    if re.fullmatch(r"\d+", v):
        return float(int(v))
    try:
        at = parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, at - (time.time() if now is None else now))


def error_from_response(status: int, headers: Mapping[str, str], body: bytes) -> UmiakError:
    """The UmiakError of an error response."""
    retry_after = parse_retry_after(headers.get("Retry-After"))
    header_request_id = headers.get("Request-Id")
    try:
        parsed: Any = json.loads(body)
    except ValueError:
        parsed = None
    env = parsed.get("error") if isinstance(parsed, dict) else None
    if (
        isinstance(env, dict)
        and isinstance(env.get("code"), str)
        and isinstance(env.get("retryable"), bool)
    ):
        message = env.get("message")
        details = env.get("details")
        request_id = env.get("requestId")
        return UmiakError(
            status=status,
            code=env["code"],
            message=message if isinstance(message, str) else env["code"],
            retryable=env["retryable"],
            details=details if isinstance(details, dict) else {},
            request_id=request_id if isinstance(request_id, str) else header_request_id,
            retry_after=retry_after,
        )
    snippet = body[:200].decode("utf-8", "replace").strip()
    return UmiakError(
        status=status,
        code=UNEXPECTED_RESPONSE,
        message=f"HTTP {status}: {snippet}" if snippet else f"HTTP {status}",
        retryable=False,
        request_id=header_request_id,
        retry_after=retry_after,
    )


def broken(message: str) -> UmiakError:
    """A broken connection or stream: safe to reopen from the offsets."""
    return UmiakError(status=0, code=NETWORK_ERROR, message=message, retryable=True)


def frame_error(f: Mapping[str, Any]) -> UmiakError:
    """An ``error`` frame of a command stream (status 0: the answer itself was 200)."""
    code = f.get("code") if isinstance(f.get("code"), str) else "internal"
    message = f.get("message")
    details = f.get("details")
    request_id = f.get("requestId")
    return UmiakError(
        status=0,
        code=code,
        message=message if isinstance(message, str) else code,
        retryable=f.get("retryable") is True,
        details=details if isinstance(details, dict) else {},
        request_id=request_id if isinstance(request_id, str) else None,
    )
