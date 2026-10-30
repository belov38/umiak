from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_attached_frame_encoding import CommandAttachedFrameEncoding
from ..models.command_attached_frame_type import CommandAttachedFrameType
from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandAttachedFrame")


@_attrs_define
class CommandAttachedFrame:
    """
    Attributes:
        command_id (str):
        encoding (CommandAttachedFrameEncoding):
        stderr_offset (int):
        stdout_offset (int):
        type_ (CommandAttachedFrameType):
        pty_offset (int | Unset): PTY commands only
    """

    command_id: str
    encoding: CommandAttachedFrameEncoding
    stderr_offset: int
    stdout_offset: int
    type_: CommandAttachedFrameType
    pty_offset: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command_id = self.command_id

        encoding = self.encoding.value

        stderr_offset = self.stderr_offset

        stdout_offset = self.stdout_offset

        type_ = self.type_.value

        pty_offset = self.pty_offset

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "commandId": command_id,
                "encoding": encoding,
                "stderrOffset": stderr_offset,
                "stdoutOffset": stdout_offset,
                "type": type_,
            }
        )
        if pty_offset is not UNSET:
            field_dict["ptyOffset"] = pty_offset

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        command_id = d.pop("commandId")

        encoding = CommandAttachedFrameEncoding(d.pop("encoding"))

        stderr_offset = d.pop("stderrOffset")

        stdout_offset = d.pop("stdoutOffset")

        type_ = CommandAttachedFrameType(d.pop("type"))

        pty_offset = d.pop("ptyOffset", UNSET)

        command_attached_frame = cls(
            command_id=command_id,
            encoding=encoding,
            stderr_offset=stderr_offset,
            stdout_offset=stdout_offset,
            type_=type_,
            pty_offset=pty_offset,
        )

        command_attached_frame.additional_properties = d
        return command_attached_frame

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
