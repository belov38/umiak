from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="SettingsQuota")


@_attrs_define
class SettingsQuota:
    """
    Attributes:
        max_active_sandboxes (int | None):
        max_ram_mb (int | None):
        max_saved_snapshots (int | None):
    """

    max_active_sandboxes: int | None
    max_ram_mb: int | None
    max_saved_snapshots: int | None

    def to_dict(self) -> dict[str, Any]:
        max_active_sandboxes: int | None
        max_active_sandboxes = self.max_active_sandboxes

        max_ram_mb: int | None
        max_ram_mb = self.max_ram_mb

        max_saved_snapshots: int | None
        max_saved_snapshots = self.max_saved_snapshots

        field_dict: dict[str, Any] = {}

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

        def _parse_max_active_sandboxes(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        max_active_sandboxes = _parse_max_active_sandboxes(d.pop("maxActiveSandboxes"))

        def _parse_max_ram_mb(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        max_ram_mb = _parse_max_ram_mb(d.pop("maxRamMb"))

        def _parse_max_saved_snapshots(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        max_saved_snapshots = _parse_max_saved_snapshots(d.pop("maxSavedSnapshots"))

        settings_quota = cls(
            max_active_sandboxes=max_active_sandboxes,
            max_ram_mb=max_ram_mb,
            max_saved_snapshots=max_saved_snapshots,
        )

        return settings_quota
