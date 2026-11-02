from enum import StrEnum


class SandboxStopReasonType1(StrEnum):
    IDLE = "idle"
    RETENTION = "retention"
    TTL = "ttl"
    UNEXPECTED_SHUTDOWN = "unexpected_shutdown"
    USER = "user"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "SandboxStopReasonType1 | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
