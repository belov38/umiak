from enum import StrEnum


class DesktopActBodyActionsItemType1Type(StrEnum):
    CLICK = "click"

    def __str__(self) -> str:
        return str(self.value)
