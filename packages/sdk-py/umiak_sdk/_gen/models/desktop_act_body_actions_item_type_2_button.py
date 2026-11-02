from enum import StrEnum


class DesktopActBodyActionsItemType2Button(StrEnum):
    LEFT = "left"
    MIDDLE = "middle"
    RIGHT = "right"

    def __str__(self) -> str:
        return str(self.value)
