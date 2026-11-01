from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_truncated_frame_stream import CommandTruncatedFrameStream
from ..models.command_truncated_frame_type import CommandTruncatedFrameType

T = TypeVar("T", bound="CommandTruncatedFrame")


@_attrs_define
class CommandTruncatedFrame:
    """
    Attributes:
        available_from (int):
        stream (CommandTruncatedFrameStream):
        type_ (CommandTruncatedFrameType):
    """

    available_from: int
    stream: CommandTruncatedFrameStream
    type_: CommandTruncatedFrameType
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        available_from = self.available_from

        stream = self.stream.value

        type_ = self.type_.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "availableFrom": available_from,
                "stream": stream,
                "type": type_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        available_from = d.pop("availableFrom")

        stream = CommandTruncatedFrameStream(d.pop("stream"))

        type_ = CommandTruncatedFrameType(d.pop("type"))

        command_truncated_frame = cls(
            available_from=available_from,
            stream=stream,
            type_=type_,
        )

        command_truncated_frame.additional_properties = d
        return command_truncated_frame

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
