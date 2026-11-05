from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SnapshotProgress")


@_attrs_define
class SnapshotProgress:
    """
    Attributes:
        target_node (str):
        total_bytes (float):
        verified_bytes (float):
    """

    target_node: str
    total_bytes: float
    verified_bytes: float
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        target_node = self.target_node

        total_bytes = self.total_bytes

        verified_bytes = self.verified_bytes

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "targetNode": target_node,
                "totalBytes": total_bytes,
                "verifiedBytes": verified_bytes,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        target_node = d.pop("targetNode")

        total_bytes = d.pop("totalBytes")

        verified_bytes = d.pop("verifiedBytes")

        snapshot_progress = cls(
            target_node=target_node,
            total_bytes=total_bytes,
            verified_bytes=verified_bytes,
        )

        snapshot_progress.additional_properties = d
        return snapshot_progress

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
