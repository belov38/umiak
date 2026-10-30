from enum import StrEnum


class CommandStartedFrameType(StrEnum):
    STARTED = "started"

    def __str__(self) -> str:
        return str(self.value)
