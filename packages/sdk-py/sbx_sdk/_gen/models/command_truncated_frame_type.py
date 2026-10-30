from enum import StrEnum


class CommandTruncatedFrameType(StrEnum):
    TRUNCATED = "truncated"

    def __str__(self) -> str:
        return str(self.value)
