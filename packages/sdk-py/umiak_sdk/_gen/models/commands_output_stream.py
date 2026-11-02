from enum import StrEnum


class CommandsOutputStream(StrEnum):
    PTY = "pty"
    STDERR = "stderr"
    STDOUT = "stdout"

    def __str__(self) -> str:
        return str(self.value)
