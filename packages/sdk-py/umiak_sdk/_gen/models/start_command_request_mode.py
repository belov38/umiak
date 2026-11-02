from enum import StrEnum


class StartCommandRequestMode(StrEnum):
    DETACHED = "detached"
    STREAM = "stream"
    SYNC = "sync"

    def __str__(self) -> str:
        return str(self.value)
