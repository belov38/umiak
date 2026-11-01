from enum import StrEnum


class DesktopActBodyActionsItemType1Button(StrEnum):
    LEFT = "left"
    MIDDLE = "middle"
    RIGHT = "right"

    def __str__(self) -> str:
        return str(self.value)
