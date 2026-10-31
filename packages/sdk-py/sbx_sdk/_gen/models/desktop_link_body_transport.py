from enum import StrEnum


class DesktopLinkBodyTransport(StrEnum):
    AUTO = "auto"
    WEBRTC = "webrtc"
    WEBSOCKET = "websocket"

    def __str__(self) -> str:
        return str(self.value)
