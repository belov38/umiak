from enum import StrEnum


class CommandExitFrameStatus(StrEnum):
    EXITED = "exited"
    FAILED_TO_START = "failed_to_start"
    KILLED = "killed"
    LOST = "lost"
    TIMED_OUT = "timed_out"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "CommandExitFrameStatus | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
