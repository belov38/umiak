from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.me_team_role_type_1 import MeTeamRoleType1
from ..models.me_team_role_type_2_type_1 import MeTeamRoleType2Type1
from ..models.me_team_role_type_3_type_1 import MeTeamRoleType3Type1

T = TypeVar("T", bound="MeTeam")


@_attrs_define
class MeTeam:
    """Team of this request (Sbx-Team or the default team)

    Attributes:
        id (str):  Example: team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        name (str):
        role (MeTeamRoleType1 | MeTeamRoleType2Type1 | MeTeamRoleType3Type1 | None): Role in the team; null for team
            keys and operators outside the team
    """

    id: str
    name: str
    role: MeTeamRoleType1 | MeTeamRoleType2Type1 | MeTeamRoleType3Type1 | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        name = self.name

        role: None | str
        if isinstance(self.role, MeTeamRoleType1):
            role = self.role.value
        elif isinstance(self.role, MeTeamRoleType2Type1):
            role = self.role.value
        elif isinstance(self.role, MeTeamRoleType3Type1):
            role = self.role.value
        else:
            role = self.role

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "name": name,
                "role": role,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        name = d.pop("name")

        def _parse_role(
            data: object,
        ) -> MeTeamRoleType1 | MeTeamRoleType2Type1 | MeTeamRoleType3Type1 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_1 = MeTeamRoleType1(data)

                return role_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_2_type_1 = MeTeamRoleType2Type1(data)

                return role_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                role_type_3_type_1 = MeTeamRoleType3Type1(data)

                return role_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MeTeamRoleType1 | MeTeamRoleType2Type1 | MeTeamRoleType3Type1 | None, data)

        role = _parse_role(d.pop("role"))

        me_team = cls(
            id=id,
            name=name,
            role=role,
        )

        me_team.additional_properties = d
        return me_team

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
