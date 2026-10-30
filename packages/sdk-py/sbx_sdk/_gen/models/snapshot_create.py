from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.operation import Operation
    from ..models.snapshot import Snapshot


T = TypeVar("T", bound="SnapshotCreate")


@_attrs_define
class SnapshotCreate:
    """The new snapshot (creating) and the save_snapshot operation of the source sandbox

    Attributes:
        operation (Operation): A long-running action on a sandbox; wait with GET /v1/operations/{operation}?waitSeconds=
        snapshot (Snapshot): A saved snapshot; create a sandbox from it with POST /v1/sandboxes {from: {snapshot: name}}
    """

    operation: Operation
    snapshot: Snapshot
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        operation = self.operation.to_dict()

        snapshot = self.snapshot.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "operation": operation,
                "snapshot": snapshot,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operation import Operation  # noqa: PLC0415
        from ..models.snapshot import Snapshot  # noqa: PLC0415

        d = dict(src_dict)
        operation = Operation.from_dict(d.pop("operation"))

        snapshot = Snapshot.from_dict(d.pop("snapshot"))

        snapshot_create = cls(
            operation=operation,
            snapshot=snapshot,
        )

        snapshot_create.additional_properties = d
        return snapshot_create

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
