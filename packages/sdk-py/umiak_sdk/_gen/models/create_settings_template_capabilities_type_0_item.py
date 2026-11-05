from enum import StrEnum


class CreateSettingsTemplateCapabilitiesType0Item(StrEnum):
    DESKTOP = "desktop"
    EXEC = "exec"
    FILES = "files"
    SSH = "ssh"

    def __str__(self) -> str:
        return str(self.value)
