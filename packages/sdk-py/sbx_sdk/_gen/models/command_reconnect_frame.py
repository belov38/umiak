from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_reconnect_frame_reason import CommandReconnectFrameReason
from ..models.command_reconnect_frame_type import CommandReconnectFrameType
from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandReconnectFrame")


@_attrs_define
class CommandReconnectFrame:
    """
    Attributes:
        reason (CommandReconnectFrameReason):
        stderr_offset (int):
        stdout_offset (int):
        type_ (CommandReconnectFrameType):
        pty_offset (int | Unset): PTY commands only
    """

    reason: CommandReconnectFrameReason
    stderr_offset: int
    stdout_offset: int
    type_: CommandReconnectFrameType
    pty_offset: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        reason = self.reason.value

        stderr_offset = self.stderr_offset

        stdout_offset = self.stdout_offset

        type_ = self.type_.value

        pty_offset = self.pty_offset

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "reason": reason,
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
        reason = CommandReconnectFrameReason(d.pop("reason"))

        stderr_offset = d.pop("stderrOffset")

        stdout_offset = d.pop("stdoutOffset")

        type_ = CommandReconnectFrameType(d.pop("type"))

        pty_offset = d.pop("ptyOffset", UNSET)

        command_reconnect_frame = cls(
            reason=reason,
            stderr_offset=stderr_offset,
            stdout_offset=stdout_offset,
            type_=type_,
            pty_offset=pty_offset,
        )

        command_reconnect_frame.additional_properties = d
        return command_reconnect_frame

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
