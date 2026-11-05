from enum import StrEnum


class OperationProgressPhase(StrEnum):
    QUEUED = "queued"

    def __str__(self) -> str:
        return str(self.value)
