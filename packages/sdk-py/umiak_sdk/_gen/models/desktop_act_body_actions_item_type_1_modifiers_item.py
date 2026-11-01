from enum import StrEnum


class DesktopActBodyActionsItemType1ModifiersItem(StrEnum):
    ALT = "alt"
    CTRL = "ctrl"
    META = "meta"
    SHIFT = "shift"

    def __str__(self) -> str:
        return str(self.value)
