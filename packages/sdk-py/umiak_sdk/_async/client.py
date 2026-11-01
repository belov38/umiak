"""Transport of AsyncUmiak: an httpx client whose transport adds

- the credential chain (S7 §7.6): Authorization, Umiak-Team, User-Agent;
- an Idempotency-Key (UUIDv4) on the keyed POSTs of S7 §5.7 when the caller
  set none; it lives on the request, so every retry repeats it;
- the retry policy of ``_retry.py`` within the call's retry budget;
- one new token and one repeat on ``401 token_expired``;
- every non-2xx answer and network failure raised as UmiakError.

Requests are built against a placeholder base URL; the transport points them
at the API URL once the credentials are known (the URL may come from the umiak
profile). A token is only ever sent to that API URL.

``umiak.raw`` is the generated client (``umiak_sdk._gen``) over the same httpx
client, so its functions get the same behaviour.
"""

from __future__ import annotations

import os
import random as _random
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import httpx

from .._credentials import (
    DEFAULT_AUTH_COMMAND,
    AuthToken,
    Chain,
    no_api_url,
    no_credentials,
    parse_auth_token,
    provided_token,
    provider_failure,
    read_chain,
    same_api,
    trim_slash,
)
from .._errors import NETWORK_ERROR, UNEXPECTED_RESPONSE, UmiakError, error_from_response
from .._events import STREAM_IDLE_TIMEOUT
from .._gen.client import Client as GenClient
from .._retry import (
    DEFAULT_RETRY_BUDGET,
    is_retryable,
    is_safe_to_repeat,
    new_idempotency_key,
    over_budget,
    retry_delay,
    takes_idempotency_key,
)
from ._io import Lock, maybe_await, run_auth_command, sleep

SDK_VERSION = "0.1.0"
PLACEHOLDER_HOST = "umiak-api.invalid"
PLACEHOLDER_URL = f"http://{PLACEHOLDER_HOST}"
DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_NETWORK_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)

#: Called with ``force`` (True after ``401 token_expired``: return a new token).
TokenProvider = Callable[[bool], Any]


class AsyncCredentials:
    """The API URL, the team and the bearer source."""

    def __init__(self, base_url: str, team: str | None) -> None:
        self.base_url = trim_slash(base_url)
        self.team = team

    async def get_token(self, force: bool = False) -> str:
        """The bearer; ``force`` skips any cache (after ``401 token_expired``)."""
        raise NotImplementedError


class _FixedToken(AsyncCredentials):
    def __init__(self, base_url: str, team: str | None, token: str) -> None:
        super().__init__(base_url, team)
        self._token = token

    async def get_token(self, force: bool = False) -> str:
        return self._token


class _ProviderToken(AsyncCredentials):
    """The caller's token_provider, called before every request (it owns its caching)."""

    def __init__(self, base_url: str, team: str | None, provider: TokenProvider) -> None:
        super().__init__(base_url, team)
        self._provider = provider

    async def get_token(self, force: bool = False) -> str:
        try:
            value = await maybe_await(self._provider(force))
        except UmiakError:
            raise
        except Exception as err:
            raise provider_failure(err) from err
        return provided_token(value)


class _ProfileToken(AsyncCredentials):
    """``umiak auth token --json``: cached until expiresAt - 60 s; refreshes share one run."""

    def __init__(
        self,
        base_url: str,
        team: str | None,
        current: AuthToken,
        cmd: Sequence[str],
        env: Mapping[str, str],
    ) -> None:
        super().__init__(base_url, team)
        self._current = current
        self._cmd = cmd
        self._env = env
        self._lock = Lock()
        self._generation = 0

    async def get_token(self, force: bool = False) -> str:
        if not force and self._current.fresh():
            return self._current.token
        seen = self._generation
        async with self._lock:
            if self._generation != seen:
                # Another caller refreshed while this one waited.
                return self._current.token
            nxt = parse_auth_token(await run_auth_command(self._cmd, self._env))
            if not same_api(self.base_url, nxt.api_url):
                raise no_credentials(
                    f"the umiak profile is now for {nxt.api_url}, not {self.base_url}"
                )
            self._current = nxt
            self._generation += 1
            return nxt.token


async def resolve_credentials(
    chain: Chain, env: Mapping[str, str], auth_command: Sequence[str]
) -> AsyncCredentials:
    if chain.token is not None:
        if chain.url is None:
            raise no_api_url()
        return _FixedToken(chain.url, chain.team, chain.token)
    if chain.provider is not None:
        if chain.url is None:
            raise no_api_url()
        return _ProviderToken(chain.url, chain.team, chain.provider)
    current = parse_auth_token(await run_auth_command(auth_command, env))
    if chain.url is not None and not same_api(chain.url, current.api_url):
        raise no_credentials(f"the umiak profile is for {current.api_url}, not {chain.url}")
    return _ProfileToken(
        chain.url or current.api_url, chain.team or current.team, current, auth_command, env
    )


def _network_error(err: Exception, method: str, keyed: bool) -> UmiakError:
    why = str(err) or type(err).__name__
    e = UmiakError(
        status=0,
        code=NETWORK_ERROR,
        message=f"network error: {why}",
        # The outcome is unknown: only a request that may run twice is safe.
        retryable=is_safe_to_repeat(method, keyed),
    )
    e.__cause__ = err
    return e


def _token_expired(err: UmiakError) -> bool:
    return err.status == 401 and err.code == "token_expired"


def _api_path(request: httpx.Request, base_url: str) -> str | None:
    """Points a placeholder request at the API; the path under the API URL, or
    None when the request goes elsewhere (it then gets no credentials)."""
    url = request.url
    api = httpx.URL(base_url)
    if url.host == PLACEHOLDER_HOST:
        prefix = api.raw_path.split(b"?")[0].rstrip(b"/")
        request.url = api.copy_with(raw_path=prefix + url.raw_path)
        request.headers["Host"] = request.url.netloc.decode("ascii")
        return url.path
    base_path = api.path.rstrip("/")
    if (url.scheme, url.host, url.port) == (api.scheme, api.host, api.port) and (
        url.path == base_path or url.path.startswith(base_path + "/")
    ):
        return url.path[len(base_path) :]
    return None


class AsyncUmiakTransport(httpx.AsyncBaseTransport):
    def __init__(self, core: AsyncClientCore, inner: httpx.AsyncBaseTransport) -> None:
        self._core = core
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        core = self._core
        creds = await core.credentials()
        path = _api_path(request, creds.base_url)
        opts: Mapping[str, Any] = request.extensions.get("umiak") or {}
        budget = opts.get("retry_budget")
        budget = core.retry_budget if budget is None else budget
        read_body = opts.get("read_body") is True
        h = request.headers
        if path is not None:
            h["Authorization"] = f"Bearer {await creds.get_token(False)}"
            if creds.team is not None and "Umiak-Team" not in h:
                h["Umiak-Team"] = creds.team
            if "Idempotency-Key" not in h and takes_idempotency_key(request.method, path):
                h["Idempotency-Key"] = new_idempotency_key()
        h["User-Agent"] = core.user_agent
        keyed = "Idempotency-Key" in h
        safe = is_safe_to_repeat(request.method, keyed)
        # A streamed body cannot be sent twice; a bytes body can.
        one_shot = not isinstance(request.stream, httpx.ByteStream)
        refreshed = False
        started = time.monotonic()
        attempt = 0
        while True:
            try:
                return await self._send(request, keyed, read_body)
            except UmiakError as err:
                last = err
            if path is not None and not refreshed and not one_shot and _token_expired(last):
                refreshed = True
                h["Authorization"] = f"Bearer {await creds.get_token(True)}"
                try:
                    return await self._send(request, keyed, read_body)
                except UmiakError as err:
                    last = err
            if one_shot or not is_retryable(last, safe):
                raise last
            wait = retry_delay(last, attempt, core.random)
            if over_budget(budget, time.monotonic() - started, wait):
                raise last
            await sleep(wait)
            attempt += 1

    async def _send(self, request: httpx.Request, keyed: bool, read_body: bool) -> httpx.Response:
        """One attempt; ``read_body``: a 2xx body is read here, so a break in it is retried."""
        try:
            resp = await self._inner.handle_async_request(request)
        except _NETWORK_ERRORS as err:
            raise _network_error(err, request.method, keyed) from err
        if 200 <= resp.status_code < 300:
            if read_body:
                try:
                    await resp.aread()
                except _NETWORK_ERRORS as err:
                    await resp.aclose()
                    raise _network_error(err, request.method, keyed) from err
            return resp
        try:
            body = await resp.aread()
        except _NETWORK_ERRORS:
            body = b""
        finally:
            await resp.aclose()
        raise error_from_response(resp.status_code, resp.headers, body)

    async def aclose(self) -> None:
        await self._inner.aclose()


class _Body:
    """A JSON body given as a dict, for the generated functions (they call ``to_dict``)."""

    def __init__(self, data: Mapping[str, Any]) -> None:
        self._data = dict(data)

    def to_dict(self) -> dict[str, Any]:
        return self._data


def body_of(value: Any) -> Any:
    """A generated model as is; a dict (API field names) wrapped for the generated code."""
    if hasattr(value, "to_dict"):
        return value
    return _Body(value or {})


class AsyncClientCore:
    """What the facade objects share: the httpx client, credentials and settings."""

    def __init__(
        self,
        *,
        base_url: str | None,
        team: str | None,
        api_key: str | None,
        access_token: str | None,
        token_provider: TokenProvider | None,
        env: Mapping[str, str] | None,
        auth_command: Sequence[str] | None,
        user_agent: str | None,
        retry_budget: float | None,
        stream_idle_timeout: float | None,
        transport: httpx.AsyncBaseTransport | None,
        random: Callable[[], float] | None = None,
    ) -> None:
        self._env: Mapping[str, str] = dict(os.environ) if env is None else env
        self._chain = read_chain(
            base_url=base_url,
            team=team,
            api_key=api_key,
            access_token=access_token,
            token_provider=token_provider,
            env=self._env,
        )
        self._auth_command = tuple(auth_command or DEFAULT_AUTH_COMMAND)
        self.user_agent = user_agent or f"umiak-sdk-py/{SDK_VERSION}"
        self.retry_budget = DEFAULT_RETRY_BUDGET if retry_budget is None else retry_budget
        self.stream_idle_timeout = (
            STREAM_IDLE_TIMEOUT if stream_idle_timeout is None else stream_idle_timeout
        )
        self.random = random or _random.random
        self._creds: AsyncCredentials | None = None
        self._creds_lock = Lock()
        self.http = httpx.AsyncClient(
            base_url=PLACEHOLDER_URL,
            transport=AsyncUmiakTransport(self, transport or httpx.AsyncHTTPTransport()),
            timeout=DEFAULT_TIMEOUT,
            follow_redirects=False,
        )
        self.raw = GenClient(base_url=PLACEHOLDER_URL)
        self.raw.set_async_httpx_client(self.http)

    async def credentials(self) -> AsyncCredentials:
        """Resolved on first use; a failure is not kept, so a later `umiak login` helps."""
        if self._creds is not None:
            return self._creds
        async with self._creds_lock:
            if self._creds is None:
                self._creds = await resolve_credentials(self._chain, self._env, self._auth_command)
            return self._creds

    @staticmethod
    def _prepare(
        kwargs: Mapping[str, Any],
        *,
        retry_budget: float | None,
        idempotency_key: str | None,
        headers: Mapping[str, str] | None,
        timeout: httpx.Timeout | float | None,
        read_body: bool,
    ) -> dict[str, Any]:
        kw = dict(kwargs)
        h = dict(kw.get("headers") or {})
        if headers:
            h.update(headers)
        if idempotency_key is not None:
            h["Idempotency-Key"] = idempotency_key
        kw["headers"] = h
        kw["extensions"] = {"umiak": {"retry_budget": retry_budget, "read_body": read_body}}
        if timeout is not None:
            kw["timeout"] = timeout
        return kw

    async def send(
        self,
        kwargs: Mapping[str, Any],
        *,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: httpx.Timeout | float | None = None,
    ) -> httpx.Response:
        """Sends the kwargs of a generated ``_get_kwargs``; returns the read 2xx response."""
        kw = self._prepare(
            kwargs,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
            headers=headers,
            timeout=timeout,
            read_body=True,
        )
        try:
            return await self.http.request(**kw)
        except _NETWORK_ERRORS as err:
            # The body of a 2xx answer broke while it was read.
            raise _network_error(err, kw["method"], "Idempotency-Key" in kw["headers"]) from err

    def stream(
        self,
        kwargs: Mapping[str, Any],
        *,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: httpx.Timeout | float | None = None,
    ) -> Any:
        """``async with core.stream(kwargs) as response``: the body is not read yet."""
        kw = self._prepare(
            kwargs,
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
            headers=headers,
            timeout=timeout,
            read_body=False,
        )
        return self.http.stream(**kw)

    async def call(
        self,
        endpoint: Any,
        *args: Any,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: httpx.Timeout | float | None = None,
        **params: Any,
    ) -> Any:
        """Calls a generated endpoint module; returns its parsed 2xx answer."""
        resp = await self.send(
            endpoint._get_kwargs(*args, **params),
            retry_budget=retry_budget,
            idempotency_key=idempotency_key,
            headers=headers,
            timeout=timeout,
        )
        return parse(endpoint, self.raw, resp)

    async def aclose(self) -> None:
        await self.http.aclose()


def parse(endpoint: Any, raw: GenClient, resp: httpx.Response) -> Any:
    """The generated parser of a 2xx answer; a body that does not fit is unexpected_response."""
    try:
        return endpoint._parse_response(client=raw, response=resp)
    except (ValueError, KeyError, TypeError) as err:
        e = UmiakError(
            status=resp.status_code,
            code=UNEXPECTED_RESPONSE,
            message=f"HTTP {resp.status_code} with a body that does not fit the schema: {err}",
            retryable=False,
            request_id=resp.headers.get("Request-Id"),
        )
        raise e from err
