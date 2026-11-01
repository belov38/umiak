from enum import StrEnum


class OperationKind(StrEnum):
    CREATE = "create"
    DELETE = "delete"
    FORK = "fork"
    RECOVER = "recover"
    RESUME = "resume"
    SAVE_SNAPSHOT = "save_snapshot"
    STOP = "stop"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "OperationKind | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
