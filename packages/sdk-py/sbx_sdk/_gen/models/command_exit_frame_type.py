from enum import StrEnum


class CommandExitFrameType(StrEnum):
    EXIT = "exit"

    def __str__(self) -> str:
        return str(self.value)
