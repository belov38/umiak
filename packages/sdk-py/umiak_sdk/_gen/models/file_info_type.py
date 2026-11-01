from enum import StrEnum


class FileInfoType(StrEnum):
    DIR = "dir"
    FILE = "file"
    OTHER = "other"
    SYMLINK = "symlink"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "FileInfoType | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
