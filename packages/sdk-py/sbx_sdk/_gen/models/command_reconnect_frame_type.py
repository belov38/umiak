from enum import StrEnum


class CommandReconnectFrameType(StrEnum):
    RECONNECT = "reconnect"

    def __str__(self) -> str:
        return str(self.value)
