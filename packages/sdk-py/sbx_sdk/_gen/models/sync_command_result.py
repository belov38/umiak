from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.command import Command


T = TypeVar("T", bound="SyncCommandResult")


@_attrs_define
class SyncCommandResult:
    """The result of a sync command: the tail (up to 4 MiB) of each stream

    Attributes:
        command (Command): A process started in a sandbox (S7 §9.6)
        stderr (str):
        stderr_from (int):
        stderr_truncated (bool):
        stdout (str):
        stdout_from (int): Offset of the first stdout byte returned
        stdout_truncated (bool): The answer holds only the tail; read the start with GET .../output from 0
    """

    command: Command
    stderr: str
    stderr_from: int
    stderr_truncated: bool
    stdout: str
    stdout_from: int
    stdout_truncated: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command = self.command.to_dict()

        stderr = self.stderr

        stderr_from = self.stderr_from

        stderr_truncated = self.stderr_truncated

        stdout = self.stdout

        stdout_from = self.stdout_from

        stdout_truncated = self.stdout_truncated

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "command": command,
                "stderr": stderr,
                "stderrFrom": stderr_from,
                "stderrTruncated": stderr_truncated,
                "stdout": stdout,
                "stdoutFrom": stdout_from,
                "stdoutTruncated": stdout_truncated,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.command import Command  # noqa: PLC0415

        d = dict(src_dict)
        command = Command.from_dict(d.pop("command"))

        stderr = d.pop("stderr")

        stderr_from = d.pop("stderrFrom")

        stderr_truncated = d.pop("stderrTruncated")

        stdout = d.pop("stdout")

        stdout_from = d.pop("stdoutFrom")

        stdout_truncated = d.pop("stdoutTruncated")

        sync_command_result = cls(
            command=command,
            stderr=stderr,
            stderr_from=stderr_from,
            stderr_truncated=stderr_truncated,
            stdout=stdout,
            stdout_from=stdout_from,
            stdout_truncated=stdout_truncated,
        )

        sync_command_result.additional_properties = d
        return sync_command_result

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
