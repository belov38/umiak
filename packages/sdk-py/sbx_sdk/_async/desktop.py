"""Desktop and computer-use primitives; input batches are never retried automatically."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote

if TYPE_CHECKING:
    from .sandbox import AsyncSandbox


class AsyncDesktop:
    def __init__(self, sandbox: AsyncSandbox) -> None:
        self._sb = sandbox

    async def _request(
        self,
        method: str,
        suffix: str = "",
        *,
        body: Any = None,
        params: Any = None,
        retry_budget: float | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {
            "method": method,
            "url": f"/v1/sandboxes/{quote(self._sb.id, safe='')}/desktop{suffix}",
        }
        if body is not None:
            kwargs["json"] = body
        if params is not None:
            kwargs["params"] = params
        return await self._sb.core.send(
            kwargs, retry_budget=retry_budget, idempotency_key=idempotency_key, timeout=75.0
        )

    async def status(self, *, retry_budget: float | None = None) -> dict[str, Any]:
        return (await self._request("GET", retry_budget=retry_budget)).json()

    async def link(
        self,
        *,
        fps: int | None = None,
        bitrate_kbps: int | None = None,
        transport: str | None = None,
        retry_budget: float | None = None,
    ) -> dict[str, Any]:
        body = {
            k: v
            for k, v in {"fps": fps, "bitrateKbps": bitrate_kbps, "transport": transport}.items()
            if v is not None
        }
        return (await self._request("POST", "/links", body=body, retry_budget=retry_budget)).json()

    async def set_access(self, access: str, *, retry_budget: float | None = None) -> dict[str, Any]:
        return (
            await self._request(
                "PUT", "/access", body={"access": access}, retry_budget=retry_budget
            )
        ).json()

    async def end_streams(self) -> None:
        await self._request("DELETE", "/streams", retry_budget=0)

    async def screenshot(
        self,
        *,
        format: str = "png",
        quality: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        x: int | None = None,
        y: int | None = None,
        width: int | None = None,
        height: int | None = None,
        retry_budget: float | None = None,
    ) -> dict[str, Any]:
        params = {
            k: v
            for k, v in {
                "format": format,
                "quality": quality,
                "maxWidth": max_width,
                "maxHeight": max_height,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
            }.items()
            if v is not None
        }
        response = await self._request(
            "GET", "/screenshot", params=params, retry_budget=retry_budget
        )

        def number(name: str) -> int:
            return int(response.headers[name])

        return {
            "bytes": response.content,
            "content_type": response.headers["content-type"],
            "screen": {"width": number("Sbx-Screen-Width"), "height": number("Sbx-Screen-Height")},
            "image": {"width": number("Sbx-Image-Width"), "height": number("Sbx-Image-Height")},
            "cursor": {"x": number("Sbx-Cursor-X"), "y": number("Sbx-Cursor-Y")},
        }

    async def act(
        self,
        actions: list[dict[str, Any]],
        *,
        coordinate_space: dict[str, int] | None = None,
        screenshot: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"actions": actions}
        if coordinate_space is not None:
            body["coordinateSpace"] = coordinate_space
        if screenshot is not None:
            body["screenshot"] = screenshot
        return (
            await self._request(
                "POST", "/actions", body=body, retry_budget=0, idempotency_key=idempotency_key
            )
        ).json()

    async def clipboard_get(self) -> dict[str, Any]:
        return (await self._request("GET", "/clipboard")).json()

    async def clipboard_set(self, text: str) -> None:
        await self._request("PUT", "/clipboard", body={"text": text}, retry_budget=0)
