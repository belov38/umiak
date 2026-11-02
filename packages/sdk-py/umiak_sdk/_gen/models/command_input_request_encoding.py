from enum import StrEnum


class CommandInputRequestEncoding(StrEnum):
    BASE64 = "base64"
    UTF8 = "utf8"

    def __str__(self) -> str:
        return str(self.value)
