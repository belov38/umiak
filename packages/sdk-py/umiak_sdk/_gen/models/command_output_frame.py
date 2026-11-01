from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_output_frame_type import CommandOutputFrameType

T = TypeVar("T", bound="CommandOutputFrame")


@_attrs_define
class CommandOutputFrame:
    """
    Attributes:
        data (str): Text (utf8) or base64 of exactly the bytes [offset, nextOffset)
        next_offset (int):
        offset (int):
        type_ (CommandOutputFrameType):
    """

    data: str
    next_offset: int
    offset: int
    type_: CommandOutputFrameType
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = self.data

        next_offset = self.next_offset

        offset = self.offset

        type_ = self.type_.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "data": data,
                "nextOffset": next_offset,
                "offset": offset,
                "type": type_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        data = d.pop("data")

        next_offset = d.pop("nextOffset")

        offset = d.pop("offset")

        type_ = CommandOutputFrameType(d.pop("type"))

        command_output_frame = cls(
            data=data,
            next_offset=next_offset,
            offset=offset,
            type_=type_,
        )

        command_output_frame.additional_properties = d
        return command_output_frame

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
