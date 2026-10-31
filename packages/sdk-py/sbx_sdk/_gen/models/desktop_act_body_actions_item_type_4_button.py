from enum import StrEnum


class DesktopActBodyActionsItemType4Button(StrEnum):
    LEFT = "left"
    MIDDLE = "middle"
    RIGHT = "right"

    def __str__(self) -> str:
        return str(self.value)
