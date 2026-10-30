from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LimitsUsage")


@_attrs_define
class LimitsUsage:
    """Counted like the quota: sandboxes and their RAM while creating, ready, starting or stopping; saved snapshots
    creating or ready

        Attributes:
            active_sandboxes (int):
            ram_mb (int):
            saved_snapshots (int):
    """

    active_sandboxes: int
    ram_mb: int
    saved_snapshots: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        active_sandboxes = self.active_sandboxes

        ram_mb = self.ram_mb

        saved_snapshots = self.saved_snapshots

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "activeSandboxes": active_sandboxes,
                "ramMb": ram_mb,
                "savedSnapshots": saved_snapshots,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        active_sandboxes = d.pop("activeSandboxes")

        ram_mb = d.pop("ramMb")

        saved_snapshots = d.pop("savedSnapshots")

        limits_usage = cls(
            active_sandboxes=active_sandboxes,
            ram_mb=ram_mb,
            saved_snapshots=saved_snapshots,
        )

        limits_usage.additional_properties = d
        return limits_usage

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
