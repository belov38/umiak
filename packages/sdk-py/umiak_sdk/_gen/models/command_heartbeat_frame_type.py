from enum import StrEnum


class CommandHeartbeatFrameType(StrEnum):
    HEARTBEAT = "heartbeat"

    def __str__(self) -> str:
        return str(self.value)
