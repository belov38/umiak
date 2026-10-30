from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LimitsQuota")


@_attrs_define
class LimitsQuota:
    """
    Attributes:
        max_active_sandboxes (int):
        max_ram_mb (int):
        max_saved_snapshots (int):
    """

    max_active_sandboxes: int
    max_ram_mb: int
    max_saved_snapshots: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        max_active_sandboxes = self.max_active_sandboxes

        max_ram_mb = self.max_ram_mb

        max_saved_snapshots = self.max_saved_snapshots

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "maxActiveSandboxes": max_active_sandboxes,
                "maxRamMb": max_ram_mb,
                "maxSavedSnapshots": max_saved_snapshots,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        max_active_sandboxes = d.pop("maxActiveSandboxes")

        max_ram_mb = d.pop("maxRamMb")

        max_saved_snapshots = d.pop("maxSavedSnapshots")

        limits_quota = cls(
            max_active_sandboxes=max_active_sandboxes,
            max_ram_mb=max_ram_mb,
            max_saved_snapshots=max_saved_snapshots,
        )

        limits_quota.additional_properties = d
        return limits_quota

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
