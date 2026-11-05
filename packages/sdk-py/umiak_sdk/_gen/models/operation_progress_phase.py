from enum import StrEnum


class OperationProgressPhase(StrEnum):
    MOVING = "moving"
    QUEUED = "queued"

    def __str__(self) -> str:
        return str(self.value)
