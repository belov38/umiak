from enum import StrEnum


class DesktopScreenshotFormat(StrEnum):
    JPEG = "jpeg"
    PNG = "png"

    def __str__(self) -> str:
        return str(self.value)
