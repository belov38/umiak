from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="CommandStream")


@_attrs_define
class CommandStream:
    """
    Attributes:
        available_from_bytes (int | None): Oldest offset still kept by the agent; null when unknown (sandbox not ready)
        end_bytes (int | None): Final size once the stream ended
        size_bytes (int): Bytes produced so far
    """

    available_from_bytes: int | None
    end_bytes: int | None
    size_bytes: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        available_from_bytes: int | None
        available_from_bytes = self.available_from_bytes

        end_bytes: int | None
        end_bytes = self.end_bytes

        size_bytes = self.size_bytes

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "availableFromBytes": available_from_bytes,
                "endBytes": end_bytes,
                "sizeBytes": size_bytes,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_available_from_bytes(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        available_from_bytes = _parse_available_from_bytes(d.pop("availableFromBytes"))

        def _parse_end_bytes(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        end_bytes = _parse_end_bytes(d.pop("endBytes"))

        size_bytes = d.pop("sizeBytes")

        command_stream = cls(
            available_from_bytes=available_from_bytes,
            end_bytes=end_bytes,
            size_bytes=size_bytes,
        )

        command_stream.additional_properties = d
        return command_stream

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
