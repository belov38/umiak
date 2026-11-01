from enum import StrEnum


class DesktopActBodyScreenshotFormat(StrEnum):
    JPEG = "jpeg"
    PNG = "png"

    def __str__(self) -> str:
        return str(self.value)
