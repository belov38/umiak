from enum import StrEnum


class CommandTruncatedFrameStream(StrEnum):
    PTY = "pty"
    STDERR = "stderr"
    STDOUT = "stdout"

    def __str__(self) -> str:
        return str(self.value)
