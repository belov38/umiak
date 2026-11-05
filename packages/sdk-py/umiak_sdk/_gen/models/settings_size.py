from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SettingsSize")


@_attrs_define
class SettingsSize:
    """
    Attributes:
        memory_mb (float):
        slug (str):
        sort_order (float | None):
        vcpu (float):
    """

    memory_mb: float
    slug: str
    sort_order: float | None
    vcpu: float
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        memory_mb = self.memory_mb

        slug = self.slug

        sort_order: float | None
        sort_order = self.sort_order

        vcpu = self.vcpu

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "memoryMb": memory_mb,
                "slug": slug,
                "sortOrder": sort_order,
                "vcpu": vcpu,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        memory_mb = d.pop("memoryMb")

        slug = d.pop("slug")

        def _parse_sort_order(data: object) -> float | None:
            if data is None:
                return data
            return cast(float | None, data)

        sort_order = _parse_sort_order(d.pop("sortOrder"))

        vcpu = d.pop("vcpu")

        settings_size = cls(
            memory_mb=memory_mb,
            slug=slug,
            sort_order=sort_order,
            vcpu=vcpu,
        )

        settings_size.additional_properties = d
        return settings_size

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
