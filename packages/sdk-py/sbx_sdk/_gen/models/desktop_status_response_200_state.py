from enum import StrEnum


class DesktopStatusResponse200State(StrEnum):
    READY = "ready"
    STARTING = "starting"
    UNAVAILABLE = "unavailable"

    def __str__(self) -> str:
        return str(self.value)
