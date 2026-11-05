from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.update_settings_team_quota import UpdateSettingsTeamQuota


T = TypeVar("T", bound="UpdateSettingsTeam")


@_attrs_define
class UpdateSettingsTeam:
    """
    Attributes:
        name (str | Unset):
        quota (UpdateSettingsTeamQuota | Unset):
    """

    name: str | Unset = UNSET
    quota: UpdateSettingsTeamQuota | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        quota: dict[str, Any] | Unset = UNSET
        if not isinstance(self.quota, Unset):
            quota = self.quota.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if name is not UNSET:
            field_dict["name"] = name
        if quota is not UNSET:
            field_dict["quota"] = quota

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.update_settings_team_quota import UpdateSettingsTeamQuota  # noqa: PLC0415

        d = dict(src_dict)
        name = d.pop("name", UNSET)

        _quota = d.pop("quota", UNSET)
        quota: UpdateSettingsTeamQuota | Unset
        if isinstance(_quota, Unset):
            quota = UNSET
        else:
            quota = UpdateSettingsTeamQuota.from_dict(_quota)

        update_settings_team = cls(
            name=name,
            quota=quota,
        )

        return update_settings_team
