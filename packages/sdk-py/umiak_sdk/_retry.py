"""Retry policy of the SDK transport (S7 §15.4), the same as the TS SDK.

- GET/HEAD/PUT/DELETE, and any request with an Idempotency-Key, are repeated
  on network errors and on 502/503/504/429 without the API envelope.
- An API error is repeated when its body says ``retryable: true`` (any
  method); ``retryable: false`` is never repeated.
- Backoff 0.5 s x 2 up to 8 s with full jitter; a longer Retry-After wins
  (a zero or past one never makes a zero-wait loop: the backoff still applies).
- All waits of one call fit in the retry budget (default 60 s): when the next
  wait would end past the budget, the last error is raised.

Also the Idempotency-Key routes of S7 §5.7.
"""

from __future__ import annotations

import random as _random
import re
import uuid
from collections.abc import Callable

from ._errors import UNEXPECTED_RESPONSE, UmiakError

DEFAULT_RETRY_BUDGET = 60.0
BASE_DELAY = 0.5
MAX_DELAY = 8.0
#: Attempts in a row without progress before a stream, upload or download gives up.
MAX_FAILURES = 20
IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE"})
TRANSIENT_STATUSES = frozenset({429, 502, 503, 504})

# POST routes that take an Idempotency-Key (path after the API base URL).
_KEYED_POSTS = [
    re.compile(p)
    for p in (
        r"/v1/sandboxes",
        r"/v1/sandboxes/[^/]+/fork",
        r"/v1/sandboxes/[^/]+/commands",
        r"/v1/sandboxes/[^/]+/ptys",
        r"/v1/snapshots",
    )
]


def takes_idempotency_key(method: str, path: str) -> bool:
    """Whether the SDK sets an Idempotency-Key on this request when the caller did not."""
    return method.upper() == "POST" and any(p.fullmatch(path) for p in _KEYED_POSTS)


def new_idempotency_key() -> str:
    """A new UUIDv4 Idempotency-Key."""
    return str(uuid.uuid4())


def is_safe_to_repeat(method: str, keyed: bool) -> bool:
    """A request is safe to repeat after an unknown outcome: idempotent method or a key."""
    return keyed or method.upper() in IDEMPOTENT_METHODS


def backoff(retry: int, random: Callable[[], float] = _random.random) -> float:
    """Full-jitter delay in seconds before retry number ``retry`` (0-based)."""
    return random() * min(MAX_DELAY, BASE_DELAY * 2**retry)


def is_retryable(err: BaseException, safe_to_repeat: bool) -> bool:
    """Whether a request that failed with ``err`` may be repeated."""
    if not isinstance(err, UmiakError):
        return False
    if err.code == UNEXPECTED_RESPONSE:
        return safe_to_repeat and err.status in TRANSIENT_STATUSES
    return err.retryable


def retry_delay(
    err: BaseException | None, retry: int, random: Callable[[], float] = _random.random
) -> float:
    """The wait before retry number ``retry``: the backoff, or a longer Retry-After."""
    hint = err.retry_after if isinstance(err, UmiakError) else None
    return max(hint or 0.0, backoff(retry, random))


def over_budget(budget: float, elapsed: float, wait: float) -> bool:
    """A wait of ``wait`` seconds after ``elapsed`` would not fit the budget."""
    return budget <= 0 or elapsed + wait > budget
