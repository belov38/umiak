from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.settings_team_role_type_1 import SettingsTeamRoleType1
from ..models.settings_team_role_type_2_type_1 import SettingsTeamRoleType2Type1
from ..models.settings_team_role_type_3_type_1 import SettingsTeamRoleType3Type1

if TYPE_CHECKING:
    from ..models.settings_quota import SettingsQuota


T = TypeVar("T", bound="SettingsTeam")


@_attrs_define
class SettingsTeam:
    """
    Attributes:
        id (str):
        name (str):
        personal (bool):
        quota (SettingsQuota):
        role (None | SettingsTeamRoleType1 | SettingsTeamRoleType2Type1 | SettingsTeamRoleType3Type1):
    """

    id: str
    name: str
    personal: bool
    quota: SettingsQuota
    role: None | SettingsTeamRoleType1 | SettingsTeamRoleType2Type1 | SettingsTeamRoleType3Type1
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        name = self.name

        personal = self.personal

        quota = self.quota.to_dict()

        role: None | str
        if isinstance(self.role, SettingsTeamRoleType1):
            role = self.role.value
        elif isinstance(self.role, SettingsTeamRoleType2Type1):
            role = self.role.value
        elif isinstance(self.role, SettingsTeamRoleType3Type1):
            role = self.role.value
        else:
            role = self.role

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "name": name,
                "personal": personal,
                "quota": quota,
                "role": role,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.settings_quota import SettingsQuota  # noqa: PLC0415

        d = dict(src_dict)
        id = d.pop("id")

        name = d.pop("name")

        personal = d.pop("personal")

        quota = SettingsQuota.from_dict(d.pop("quota"))

        def _parse_role(
            data: object,
        ) -> None | SettingsTeamRoleType1 | SettingsTeamRoleType2Type1 | SettingsTeamRoleType3Type1:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_1 = SettingsTeamRoleType1(data)

                return role_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_2_type_1 = SettingsTeamRoleType2Type1(data)

                return role_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_3_type_1 = SettingsTeamRoleType3Type1(data)

                return role_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                None
                | SettingsTeamRoleType1
                | SettingsTeamRoleType2Type1
                | SettingsTeamRoleType3Type1,
                data,
            )

        role = _parse_role(d.pop("role"))

        settings_team = cls(
            id=id,
            name=name,
            personal=personal,
            quota=quota,
            role=role,
        )

        settings_team.additional_properties = d
        return settings_team

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
