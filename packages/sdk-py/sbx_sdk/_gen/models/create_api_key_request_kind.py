from enum import StrEnum


class CreateApiKeyRequestKind(StrEnum):
    TEAM = "team"

    def __str__(self) -> str:
        return str(self.value)
