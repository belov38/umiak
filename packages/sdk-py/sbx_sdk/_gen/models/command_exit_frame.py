from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_exit_frame_status import CommandExitFrameStatus
from ..models.command_exit_frame_type import CommandExitFrameType
from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandExitFrame")


@_attrs_define
class CommandExitFrame:
    """
    Attributes:
        exit_code (int | None):
        reason (None | str):
        signal (None | str):
        status (CommandExitFrameStatus):
        stderr_offset (int):
        stdout_offset (int):
        type_ (CommandExitFrameType):
        pty_offset (int | Unset): PTY commands only
    """

    exit_code: int | None
    reason: None | str
    signal: None | str
    status: CommandExitFrameStatus
    stderr_offset: int
    stdout_offset: int
    type_: CommandExitFrameType
    pty_offset: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        exit_code: int | None
        exit_code = self.exit_code

        reason: None | str
        reason = self.reason

        signal: None | str
        signal = self.signal

        status = self.status.value

        stderr_offset = self.stderr_offset

        stdout_offset = self.stdout_offset

        type_ = self.type_.value

        pty_offset = self.pty_offset

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "exitCode": exit_code,
                "reason": reason,
                "signal": signal,
                "status": status,
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

        def _parse_exit_code(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        exit_code = _parse_exit_code(d.pop("exitCode"))

        def _parse_reason(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        reason = _parse_reason(d.pop("reason"))

        def _parse_signal(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        signal = _parse_signal(d.pop("signal"))

        status = CommandExitFrameStatus(d.pop("status"))

        stderr_offset = d.pop("stderrOffset")

        stdout_offset = d.pop("stdoutOffset")

        type_ = CommandExitFrameType(d.pop("type"))

        pty_offset = d.pop("ptyOffset", UNSET)

        command_exit_frame = cls(
            exit_code=exit_code,
            reason=reason,
            signal=signal,
            status=status,
            stderr_offset=stderr_offset,
            stdout_offset=stdout_offset,
            type_=type_,
            pty_offset=pty_offset,
        )

        command_exit_frame.additional_properties = d
        return command_exit_frame

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
