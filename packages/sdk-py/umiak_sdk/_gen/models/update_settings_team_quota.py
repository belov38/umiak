from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="UpdateSettingsTeamQuota")


@_attrs_define
class UpdateSettingsTeamQuota:
    """
    Attributes:
        max_active_sandboxes (int | None | Unset):
        max_ram_mb (int | None | Unset):
        max_saved_snapshots (int | None | Unset):
    """

    max_active_sandboxes: int | None | Unset = UNSET
    max_ram_mb: int | None | Unset = UNSET
    max_saved_snapshots: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        max_active_sandboxes: int | None | Unset
        if isinstance(self.max_active_sandboxes, Unset):
            max_active_sandboxes = UNSET
        else:
            max_active_sandboxes = self.max_active_sandboxes

        max_ram_mb: int | None | Unset
        if isinstance(self.max_ram_mb, Unset):
            max_ram_mb = UNSET
        else:
            max_ram_mb = self.max_ram_mb

        max_saved_snapshots: int | None | Unset
        if isinstance(self.max_saved_snapshots, Unset):
            max_saved_snapshots = UNSET
        else:
            max_saved_snapshots = self.max_saved_snapshots

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if max_active_sandboxes is not UNSET:
            field_dict["maxActiveSandboxes"] = max_active_sandboxes
        if max_ram_mb is not UNSET:
            field_dict["maxRamMb"] = max_ram_mb
        if max_saved_snapshots is not UNSET:
            field_dict["maxSavedSnapshots"] = max_saved_snapshots

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_max_active_sandboxes(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        max_active_sandboxes = _parse_max_active_sandboxes(d.pop("maxActiveSandboxes", UNSET))

        def _parse_max_ram_mb(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        max_ram_mb = _parse_max_ram_mb(d.pop("maxRamMb", UNSET))

        def _parse_max_saved_snapshots(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        max_saved_snapshots = _parse_max_saved_snapshots(d.pop("maxSavedSnapshots", UNSET))

        update_settings_team_quota = cls(
            max_active_sandboxes=max_active_sandboxes,
            max_ram_mb=max_ram_mb,
            max_saved_snapshots=max_saved_snapshots,
        )

        return update_settings_team_quota
