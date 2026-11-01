"""Credential chain (S7 §7.6, §15.3), the parts shared by Umiak and AsyncUmiak:

    explicit api_key / access_token / token_provider -> UMIAK_API_KEY
    -> UMIAK_ACCESS_TOKEN -> ``umiak auth token --json`` (the CLI owns refresh)

The API URL is ``base_url``, then UMIAK_API_URL, then the ``apiUrl`` of the umiak
profile; the team is ``team``, then UMIAK_TEAM, then the profile's team. A token
from the umiak profile is never sent to another API than the profile's apiUrl;
it is cached until ``expiresAt - 60 s`` (a key: until a forced refresh).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from ._errors import (
    AUTH_COMMAND_FAILED,
    NO_API_URL,
    NO_CREDENTIALS,
    TOKEN_PROVIDER_FAILED,
    UmiakError,
)

DEFAULT_AUTH_COMMAND: tuple[str, ...] = ("umiak", "auth", "token", "--json")
AUTH_COMMAND_TIMEOUT = 30.0
#: A token from `umiak auth token` is used until this long before it expires.
EXPIRY_MARGIN = 60.0
#: `umiak` exit code for "no permission or not logged in" (S7 §14.3).
EXIT_NO_LOGIN = 4

_HINT = (
    "pass api_key, access_token or token_provider, set UMIAK_API_KEY or UMIAK_ACCESS_TOKEN, "
    "or run `umiak login`"
)


def no_credentials(why: str) -> UmiakError:
    return UmiakError(
        status=0, code=NO_CREDENTIALS, message=f"no credentials: {why}; {_HINT}", retryable=False
    )


def no_api_url() -> UmiakError:
    return UmiakError(
        status=0,
        code=NO_API_URL,
        message="no API URL: pass base_url or set UMIAK_API_URL",
        retryable=False,
    )


def _non_empty(v: str | None) -> str | None:
    return None if v is None or v == "" else v


def trim_slash(url: str) -> str:
    return url.rstrip("/")


def same_api(a: str, b: str) -> bool:
    """Same API: equal scheme, host, port and path, ignoring trailing slashes."""
    try:
        ua, ub = urlsplit(a), urlsplit(b)
        if ua.scheme and ua.netloc and ub.scheme and ub.netloc:
            return (
                ua.scheme.lower() == ub.scheme.lower()
                and _origin(ua) == _origin(ub)
                and trim_slash(ua.path) == trim_slash(ub.path)
            )
    except ValueError:
        pass
    return trim_slash(a) == trim_slash(b)


def _origin(u: Any) -> tuple[str, int | None]:
    default = {"http": 80, "https": 443}.get(u.scheme.lower())
    return ((u.hostname or "").lower(), u.port or default)


@dataclass(frozen=True)
class AuthToken:
    """Output of ``umiak auth token --json``."""

    kind: str
    token: str
    #: Unix time; None for a key (no expiry).
    expires_at: float | None
    api_url: str
    team: str | None

    def fresh(self, now: float | None = None) -> bool:
        if self.expires_at is None:
            return True
        return self.expires_at - EXPIRY_MARGIN > (time.time() if now is None else now)


def parse_auth_token(stdout: str) -> AuthToken:
    """Validates the JSON printed by ``umiak auth token --json``."""
    try:
        o = json.loads(stdout)
    except ValueError:
        o = None
    if not isinstance(o, dict):
        o = {}
    expires = o.get("expiresAt")
    team = o.get("team")
    expires_at: float | None = None
    ok = (
        isinstance(o.get("kind"), str)
        and isinstance(o.get("token"), str)
        and o["token"] != ""
        and isinstance(o.get("apiUrl"), str)
        and (expires is None or isinstance(expires, str))
        and (team is None or isinstance(team, str))
    )
    if ok and isinstance(expires, str):
        try:
            expires_at = datetime.fromisoformat(expires).timestamp()
        except ValueError:
            ok = False
    if not ok:
        raise UmiakError(
            status=0,
            code=AUTH_COMMAND_FAILED,
            message="`umiak auth token --json` printed no {kind, token, expiresAt, apiUrl, team}",
            retryable=False,
        )
    return AuthToken(
        kind=o["kind"], token=o["token"], expires_at=expires_at, api_url=o["apiUrl"], team=team
    )


def auth_command_failure(
    cmd: Sequence[str],
    *,
    returncode: int | None = None,
    stderr: str = "",
    not_found: bool = False,
    timeout: float | None = None,
) -> UmiakError:
    """The UmiakError of an ``umiak auth token`` run that gave no token."""
    shown = " ".join(cmd)
    said = stderr.strip()
    if not_found:
        return no_credentials(
            f"no explicit credentials, no UMIAK_API_KEY or UMIAK_ACCESS_TOKEN, and `{cmd[0]}` is not in PATH"
        )
    if timeout is not None:
        return UmiakError(
            status=0,
            code=AUTH_COMMAND_FAILED,
            message=f"`{shown}` timed out after {timeout:g} s",
            retryable=False,
        )
    if returncode == EXIT_NO_LOGIN:
        return UmiakError(
            status=0,
            code=NO_CREDENTIALS,
            message=f"no credentials: `{shown}` exited 4{': ' + said if said else ''}; run `umiak login`",
            retryable=False,
        )
    return UmiakError(
        status=0,
        code=AUTH_COMMAND_FAILED,
        message=f"`{shown}` failed: {said or f'exit status {returncode}'}",
        retryable=False,
    )


@dataclass(frozen=True)
class Chain:
    """What the options and the environment say before any command runs."""

    url: str | None
    team: str | None
    #: A fixed bearer (api_key, access_token, UMIAK_API_KEY or UMIAK_ACCESS_TOKEN).
    token: str | None
    #: The caller's token_provider (called with ``force``), if no fixed bearer.
    provider: Callable[[bool], Any] | None


def read_chain(
    *,
    base_url: str | None,
    team: str | None,
    api_key: str | None,
    access_token: str | None,
    token_provider: Callable[[bool], Any] | None,
    env: Mapping[str, str],
) -> Chain:
    url = _non_empty(base_url) or _non_empty(env.get("UMIAK_API_URL"))
    team = _non_empty(team) or _non_empty(env.get("UMIAK_TEAM"))
    explicit = _non_empty(api_key) or _non_empty(access_token)
    if explicit is not None:
        return Chain(url, team, explicit, None)
    if token_provider is not None:
        return Chain(url, team, None, token_provider)
    from_env = _non_empty(env.get("UMIAK_API_KEY")) or _non_empty(env.get("UMIAK_ACCESS_TOKEN"))
    return Chain(url, team, from_env, None)


def provided_token(value: object) -> str:
    """Checks what a token_provider returned."""
    if not isinstance(value, str) or value == "":
        raise UmiakError(
            status=0,
            code=TOKEN_PROVIDER_FAILED,
            message="token_provider returned no token",
            retryable=False,
        )
    return value


def provider_failure(err: BaseException) -> UmiakError:
    """A token_provider that raised: not retryable (a token source failed, not the request)."""
    e = UmiakError(
        status=0,
        code=TOKEN_PROVIDER_FAILED,
        message=f"token_provider failed: {err}",
        retryable=False,
    )
    e.__cause__ = err
    return e
