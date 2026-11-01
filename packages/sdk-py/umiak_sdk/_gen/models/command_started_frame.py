from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_started_frame_encoding import CommandStartedFrameEncoding
from ..models.command_started_frame_type import CommandStartedFrameType
from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandStartedFrame")


@_attrs_define
class CommandStartedFrame:
    """
    Attributes:
        command_id (str):
        encoding (CommandStartedFrameEncoding):
        pid (int | None):
        type_ (CommandStartedFrameType):
        replayed (bool | Unset): A repeat with the same Idempotency-Key: the same command, from offset 0
    """

    command_id: str
    encoding: CommandStartedFrameEncoding
    pid: int | None
    type_: CommandStartedFrameType
    replayed: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command_id = self.command_id

        encoding = self.encoding.value

        pid: int | None
        pid = self.pid

        type_ = self.type_.value

        replayed = self.replayed

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "commandId": command_id,
                "encoding": encoding,
                "pid": pid,
                "type": type_,
            }
        )
        if replayed is not UNSET:
            field_dict["replayed"] = replayed

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        command_id = d.pop("commandId")

        encoding = CommandStartedFrameEncoding(d.pop("encoding"))

        def _parse_pid(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        pid = _parse_pid(d.pop("pid"))

        type_ = CommandStartedFrameType(d.pop("type"))

        replayed = d.pop("replayed", UNSET)

        command_started_frame = cls(
            command_id=command_id,
            encoding=encoding,
            pid=pid,
            type_=type_,
            replayed=replayed,
        )

        command_started_frame.additional_properties = d
        return command_started_frame

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
