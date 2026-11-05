from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="CreateSettingsSize")


@_attrs_define
class CreateSettingsSize:
    """
    Attributes:
        memory_mb (int):
        slug (str):
        vcpu (int):
        sort_order (int | Unset):
    """

    memory_mb: int
    slug: str
    vcpu: int
    sort_order: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        memory_mb = self.memory_mb

        slug = self.slug

        vcpu = self.vcpu

        sort_order = self.sort_order

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "memoryMb": memory_mb,
                "slug": slug,
                "vcpu": vcpu,
            }
        )
        if sort_order is not UNSET:
            field_dict["sortOrder"] = sort_order

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        memory_mb = d.pop("memoryMb")

        slug = d.pop("slug")

        vcpu = d.pop("vcpu")

        sort_order = d.pop("sortOrder", UNSET)

        create_settings_size = cls(
            memory_mb=memory_mb,
            slug=slug,
            vcpu=vcpu,
            sort_order=sort_order,
        )

        return create_settings_size
