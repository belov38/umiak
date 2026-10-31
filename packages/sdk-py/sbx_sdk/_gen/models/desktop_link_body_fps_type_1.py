from enum import IntEnum


class DesktopLinkBodyFpsType1(IntEnum):
    VALUE_60 = 60

    def __str__(self) -> str:
        return str(self.value)
