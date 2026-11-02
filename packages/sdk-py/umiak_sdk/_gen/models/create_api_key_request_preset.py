from enum import StrEnum


class CreateApiKeyRequestPreset(StrEnum):
    CI = "ci"
    FULL = "full"
    READ_ONLY = "read-only"

    def __str__(self) -> str:
        return str(self.value)
