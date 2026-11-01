from enum import StrEnum


class CommandErrorFrameType(StrEnum):
    ERROR = "error"

    def __str__(self) -> str:
        return str(self.value)
