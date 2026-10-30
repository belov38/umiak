from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.command_stream import CommandStream


T = TypeVar("T", bound="CommandStreamsType0")


@_attrs_define
class CommandStreamsType0:
    """Output sizes: live from the agent while the sandbox is ready, else the stored totals; null when unknown

    Attributes:
        pty (CommandStream | Unset):
        stderr (CommandStream | Unset):
        stdout (CommandStream | Unset):
    """

    pty: CommandStream | Unset = UNSET
    stderr: CommandStream | Unset = UNSET
    stdout: CommandStream | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        pty: dict[str, Any] | Unset = UNSET
        if not isinstance(self.pty, Unset):
            pty = self.pty.to_dict()

        stderr: dict[str, Any] | Unset = UNSET
        if not isinstance(self.stderr, Unset):
            stderr = self.stderr.to_dict()

        stdout: dict[str, Any] | Unset = UNSET
        if not isinstance(self.stdout, Unset):
            stdout = self.stdout.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if pty is not UNSET:
            field_dict["pty"] = pty
        if stderr is not UNSET:
            field_dict["stderr"] = stderr
        if stdout is not UNSET:
            field_dict["stdout"] = stdout

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.command_stream import CommandStream  # noqa: PLC0415

        d = dict(src_dict)
        _pty = d.pop("pty", UNSET)
        pty: CommandStream | Unset
        if isinstance(_pty, Unset):
            pty = UNSET
        else:
            pty = CommandStream.from_dict(_pty)

        _stderr = d.pop("stderr", UNSET)
        stderr: CommandStream | Unset
        if isinstance(_stderr, Unset):
            stderr = UNSET
        else:
            stderr = CommandStream.from_dict(_stderr)

        _stdout = d.pop("stdout", UNSET)
        stdout: CommandStream | Unset
        if isinstance(_stdout, Unset):
            stdout = UNSET
        else:
            stdout = CommandStream.from_dict(_stdout)

        command_streams_type_0 = cls(
            pty=pty,
            stderr=stderr,
            stdout=stdout,
        )

        command_streams_type_0.additional_properties = d
        return command_streams_type_0

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
