"""Both desktop facades preserve metadata and never retry input batches."""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from umiak_sdk._async.desktop import AsyncDesktop
from umiak_sdk._sync.desktop import Desktop


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.asyncio
async def test_desktop_wire_contract(asynchronous: bool) -> None:
    calls: list[dict[str, Any]] = []

    def answer(kwargs: dict[str, Any], **options: Any) -> httpx.Response:
        calls.append({**kwargs, **options})
        if kwargs["url"].endswith("/screenshot"):
            return httpx.Response(
                200,
                content=b"png",
                headers={
                    "Content-Type": "image/png",
                    "Umiak-Screen-Width": "1920",
                    "Umiak-Screen-Height": "1080",
                    "Umiak-Image-Width": "1280",
                    "Umiak-Image-Height": "720",
                    "Umiak-Cursor-X": "4",
                    "Umiak-Cursor-Y": "5",
                },
            )
        return httpx.Response(200, json={"completed": 1})

    async def async_answer(kwargs: dict[str, Any], **options: Any) -> httpx.Response:
        return answer(kwargs, **options)

    sb = SimpleNamespace(
        id="sb_test", core=SimpleNamespace(send=async_answer if asynchronous else answer)
    )
    desktop = AsyncDesktop(sb) if asynchronous else Desktop(sb)
    result = desktop.act(
        [{"type": "type", "text": "Привет"}],
        coordinate_space={"width": 1280, "height": 720},
        idempotency_key="key",
    )
    if inspect.isawaitable(result):
        result = await result
    assert result == {"completed": 1}
    assert calls[-1]["retry_budget"] == 0
    assert calls[-1]["idempotency_key"] == "key"
    assert calls[-1]["json"]["coordinateSpace"] == {"width": 1280, "height": 720}
    shot = desktop.screenshot(max_width=1280, max_height=720)
    if inspect.isawaitable(shot):
        shot = await shot
    assert shot["bytes"] == b"png"
    assert shot["screen"] == {"width": 1920, "height": 1080}
    assert shot["image"] == {"width": 1280, "height": 720}
    assert calls[-1]["params"]["maxWidth"] == 1280
