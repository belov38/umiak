from enum import StrEnum


class MetaTenancy(StrEnum):
    SINGLE = "single"
    TEAMS = "teams"

    def __str__(self) -> str:
        return str(self.value)
