from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.sandbox_origin_kind import SandboxOriginKind
from ..types import UNSET, Unset

T = TypeVar("T", bound="SandboxOrigin")


@_attrs_define
class SandboxOrigin:
    """What the sandbox was created from

    Attributes:
        kind (SandboxOriginKind):
        sandbox_id (str | Unset): kind fork: the source sandbox `sb_...`
        snapshot (None | str | Unset): kind snapshot: name of the saved snapshot (null once it is deleted)
        snapshot_id (str | Unset): kind snapshot: `snap_...`
    """

    kind: SandboxOriginKind
    sandbox_id: str | Unset = UNSET
    snapshot: None | str | Unset = UNSET
    snapshot_id: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        kind = self.kind.value

        sandbox_id = self.sandbox_id

        snapshot: None | str | Unset
        if isinstance(self.snapshot, Unset):
            snapshot = UNSET
        else:
            snapshot = self.snapshot

        snapshot_id = self.snapshot_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "kind": kind,
            }
        )
        if sandbox_id is not UNSET:
            field_dict["sandboxId"] = sandbox_id
        if snapshot is not UNSET:
            field_dict["snapshot"] = snapshot
        if snapshot_id is not UNSET:
            field_dict["snapshotId"] = snapshot_id

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        kind = SandboxOriginKind(d.pop("kind"))

        sandbox_id = d.pop("sandboxId", UNSET)

        def _parse_snapshot(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        snapshot = _parse_snapshot(d.pop("snapshot", UNSET))

        snapshot_id = d.pop("snapshotId", UNSET)

        sandbox_origin = cls(
            kind=kind,
            sandbox_id=sandbox_id,
            snapshot=snapshot,
            snapshot_id=snapshot_id,
        )

        sandbox_origin.additional_properties = d
        return sandbox_origin

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
