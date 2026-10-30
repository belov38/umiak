from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="EnvironmentSecretFilesItem")


@_attrs_define
class EnvironmentSecretFilesItem:
    """
    Attributes:
        link_path (None | str):
        mode (int):
        name (str):
        size_bytes (int):
    """

    link_path: None | str
    mode: int
    name: str
    size_bytes: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        link_path: None | str
        link_path = self.link_path

        mode = self.mode

        name = self.name

        size_bytes = self.size_bytes

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "linkPath": link_path,
                "mode": mode,
                "name": name,
                "sizeBytes": size_bytes,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_link_path(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        link_path = _parse_link_path(d.pop("linkPath"))

        mode = d.pop("mode")

        name = d.pop("name")

        size_bytes = d.pop("sizeBytes")

        environment_secret_files_item = cls(
            link_path=link_path,
            mode=mode,
            name=name,
            size_bytes=size_bytes,
        )

        environment_secret_files_item.additional_properties = d
        return environment_secret_files_item

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
