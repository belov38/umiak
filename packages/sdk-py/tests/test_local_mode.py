"""Both transports discover a local deployment without the CLI or a key."""

import httpx
import pytest

from umiak_sdk._async.client import resolve_credentials as async_resolve
from umiak_sdk._credentials import Chain
from umiak_sdk._sync.client import resolve_credentials


def test_local_credentials():
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"authMode": "none"})

    creds = resolve_credentials(
        Chain("http://lan:8080", None, None, None),
        {},
        ["missing-umiak"],
        httpx.MockTransport(respond),
    )
    assert creds.get_token() == ""
    assert str(seen[0].url) == "http://lan:8080/v1/meta"
    assert "authorization" not in seen[0].headers


@pytest.mark.asyncio
async def test_async_local_credentials():
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"authMode": "none"}))
    creds = await async_resolve(
        Chain("http://lan:8080", None, None, None), {}, ["missing-umiak"], transport
    )
    assert await creds.get_token() == ""
