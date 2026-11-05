from enum import StrEnum


class MetaAuthMode(StrEnum):
    OWNER = "owner"

    def __str__(self) -> str:
        return str(self.value)
