from enum import StrEnum


class MetaAuthMode(StrEnum):
    NONE = "none"
    OIDC = "oidc"

    def __str__(self) -> str:
        return str(self.value)
