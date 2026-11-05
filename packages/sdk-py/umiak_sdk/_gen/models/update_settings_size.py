from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="UpdateSettingsSize")


@_attrs_define
class UpdateSettingsSize:
    """
    Attributes:
        memory_mb (int | Unset):
        sort_order (int | Unset):
        vcpu (int | Unset):
    """

    memory_mb: int | Unset = UNSET
    sort_order: int | Unset = UNSET
    vcpu: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        memory_mb = self.memory_mb

        sort_order = self.sort_order

        vcpu = self.vcpu

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if memory_mb is not UNSET:
            field_dict["memoryMb"] = memory_mb
        if sort_order is not UNSET:
            field_dict["sortOrder"] = sort_order
        if vcpu is not UNSET:
            field_dict["vcpu"] = vcpu

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        memory_mb = d.pop("memoryMb", UNSET)

        sort_order = d.pop("sortOrder", UNSET)

        vcpu = d.pop("vcpu", UNSET)

        update_settings_size = cls(
            memory_mb=memory_mb,
            sort_order=sort_order,
            vcpu=vcpu,
        )

        return update_settings_size
