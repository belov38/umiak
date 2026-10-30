from enum import StrEnum


class CommandAttachedFrameType(StrEnum):
    ATTACHED = "attached"

    def __str__(self) -> str:
        return str(self.value)
