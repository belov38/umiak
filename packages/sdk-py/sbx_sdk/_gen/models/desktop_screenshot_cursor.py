from enum import StrEnum


class DesktopScreenshotCursor(StrEnum):
    FALSE = "false"
    TRUE = "true"

    def __str__(self) -> str:
        return str(self.value)
