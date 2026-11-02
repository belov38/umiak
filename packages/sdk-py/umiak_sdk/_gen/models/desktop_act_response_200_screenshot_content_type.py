from enum import StrEnum


class DesktopActResponse200ScreenshotContentType(StrEnum):
    IMAGEJPEG = "image/jpeg"
    IMAGEPNG = "image/png"

    def __str__(self) -> str:
        return str(self.value)
