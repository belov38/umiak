from enum import StrEnum


class MetaAuthMode(StrEnum):
    OIDC = "oidc"
    OWNER = "owner"

    def __str__(self) -> str:
        return str(self.value)
