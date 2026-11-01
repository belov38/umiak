# Generated from umiak_sdk/_async/desktop.py by scripts/gen.py; do not edit.
"""Desktop and computer-use primitives; input batches are never retried automatically."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote

if TYPE_CHECKING:
    from .sandbox import Sandbox


class Desktop:
    def __init__(self, sandbox: Sandbox) -> None:
        self._sb = sandbox

    def _request(
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
        return self._sb.core.send(
            kwargs, retry_budget=retry_budget, idempotency_key=idempotency_key, timeout=75.0
        )

    def status(self, *, retry_budget: float | None = None) -> dict[str, Any]:
        return (self._request("GET", retry_budget=retry_budget)).json()

    def link(
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
        return (self._request("POST", "/links", body=body, retry_budget=retry_budget)).json()

    def set_access(self, access: str, *, retry_budget: float | None = None) -> dict[str, Any]:
        return (
            self._request("PUT", "/access", body={"access": access}, retry_budget=retry_budget)
        ).json()

    def end_streams(self) -> None:
        self._request("DELETE", "/streams", retry_budget=0)

    def screenshot(
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
        response = self._request("GET", "/screenshot", params=params, retry_budget=retry_budget)

        def number(name: str) -> int:
            return int(response.headers[name])

        return {
            "bytes": response.content,
            "content_type": response.headers["content-type"],
            "screen": {
                "width": number("Umiak-Screen-Width"),
                "height": number("Umiak-Screen-Height"),
            },
            "image": {"width": number("Umiak-Image-Width"), "height": number("Umiak-Image-Height")},
            "cursor": {"x": number("Umiak-Cursor-X"), "y": number("Umiak-Cursor-Y")},
        }

    def act(
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
            self._request(
                "POST", "/actions", body=body, retry_budget=0, idempotency_key=idempotency_key
            )
        ).json()

    def clipboard_get(self) -> dict[str, Any]:
        return (self._request("GET", "/clipboard")).json()

    def clipboard_set(self, text: str) -> None:
        self._request("PUT", "/clipboard", body={"text": text}, retry_budget=0)
