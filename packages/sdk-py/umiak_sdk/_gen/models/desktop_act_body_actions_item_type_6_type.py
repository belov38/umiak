from enum import StrEnum


class DesktopActBodyActionsItemType6Type(StrEnum):
    KEY_DOWN = "key_down"
    KEY_UP = "key_up"

    def __str__(self) -> str:
        return str(self.value)
