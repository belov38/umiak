from enum import StrEnum


class CommandSignalRequestSignal(StrEnum):
    SIGHUP = "SIGHUP"
    SIGINT = "SIGINT"
    SIGKILL = "SIGKILL"
    SIGQUIT = "SIGQUIT"
    SIGTERM = "SIGTERM"
    SIGUSR1 = "SIGUSR1"
    SIGUSR2 = "SIGUSR2"

    def __str__(self) -> str:
        return str(self.value)
