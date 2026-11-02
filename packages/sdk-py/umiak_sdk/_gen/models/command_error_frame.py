from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_error_frame_type import CommandErrorFrameType
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.command_error_frame_details import CommandErrorFrameDetails


T = TypeVar("T", bound="CommandErrorFrame")


@_attrs_define
class CommandErrorFrame:
    """
    Attributes:
        code (str):
        message (str):
        request_id (str):
        retryable (bool):
        stderr_offset (int):
        stdout_offset (int):
        type_ (CommandErrorFrameType):
        details (CommandErrorFrameDetails | Unset): Only on some errors: `forbidden` after an operator blocked the
            sandbox has `reason: sandbox_blocked`
        pty_offset (int | Unset): PTY commands only
    """

    code: str
    message: str
    request_id: str
    retryable: bool
    stderr_offset: int
    stdout_offset: int
    type_: CommandErrorFrameType
    details: CommandErrorFrameDetails | Unset = UNSET
    pty_offset: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code

        message = self.message

        request_id = self.request_id

        retryable = self.retryable

        stderr_offset = self.stderr_offset

        stdout_offset = self.stdout_offset

        type_ = self.type_.value

        details: dict[str, Any] | Unset = UNSET
        if not isinstance(self.details, Unset):
            details = self.details.to_dict()

        pty_offset = self.pty_offset

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "message": message,
                "requestId": request_id,
                "retryable": retryable,
                "stderrOffset": stderr_offset,
                "stdoutOffset": stdout_offset,
                "type": type_,
            }
        )
        if details is not UNSET:
            field_dict["details"] = details
        if pty_offset is not UNSET:
            field_dict["ptyOffset"] = pty_offset

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.command_error_frame_details import CommandErrorFrameDetails  # noqa: PLC0415

        d = dict(src_dict)
        code = d.pop("code")

        message = d.pop("message")

        request_id = d.pop("requestId")

        retryable = d.pop("retryable")

        stderr_offset = d.pop("stderrOffset")

        stdout_offset = d.pop("stdoutOffset")

        type_ = CommandErrorFrameType(d.pop("type"))

        _details = d.pop("details", UNSET)
        details: CommandErrorFrameDetails | Unset
        if isinstance(_details, Unset):
            details = UNSET
        else:
            details = CommandErrorFrameDetails.from_dict(_details)

        pty_offset = d.pop("ptyOffset", UNSET)

        command_error_frame = cls(
            code=code,
            message=message,
            request_id=request_id,
            retryable=retryable,
            stderr_offset=stderr_offset,
            stdout_offset=stdout_offset,
            type_=type_,
            details=details,
            pty_offset=pty_offset,
        )

        command_error_frame.additional_properties = d
        return command_error_frame

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
