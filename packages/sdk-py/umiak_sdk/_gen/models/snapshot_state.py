from enum import StrEnum


class SnapshotState(StrEnum):
    CREATING = "creating"
    DELETING = "deleting"
    FAILED = "failed"
    MOVING = "moving"
    READY = "ready"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "SnapshotState | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
