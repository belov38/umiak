from enum import StrEnum


class ApiKeyScopesItem(StrEnum):
    COMMANDSEXEC = "commands:exec"
    COMMANDSREAD = "commands:read"
    ENVIRONMENTSREAD = "environments:read"
    ENVIRONMENTSWRITE = "environments:write"
    FILESREAD = "files:read"
    FILESWRITE = "files:write"
    KEYSADMIN = "keys:admin"
    PORTSWRITE = "ports:write"
    SANDBOXESDELETE = "sandboxes:delete"
    SANDBOXESREAD = "sandboxes:read"
    SANDBOXESWRITE = "sandboxes:write"
    SNAPSHOTSREAD = "snapshots:read"
    SNAPSHOTSWRITE = "snapshots:write"
    SSHCONNECT = "ssh:connect"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "ApiKeyScopesItem | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
