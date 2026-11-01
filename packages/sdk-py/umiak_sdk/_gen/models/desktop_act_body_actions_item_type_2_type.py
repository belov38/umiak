from enum import StrEnum


class DesktopActBodyActionsItemType2Type(StrEnum):
    MOUSE_DOWN = "mouse_down"
    MOUSE_UP = "mouse_up"

    def __str__(self) -> str:
        return str(self.value)
