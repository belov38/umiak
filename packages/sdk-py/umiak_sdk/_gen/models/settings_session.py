from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.settings_session_user import SettingsSessionUser
    from ..models.settings_team import SettingsTeam


T = TypeVar("T", bound="SettingsSession")


@_attrs_define
class SettingsSession:
    """
    Attributes:
        default_team_id (str):
        is_operator (bool):
        teams (list[SettingsTeam]):
        user (SettingsSessionUser):
    """

    default_team_id: str
    is_operator: bool
    teams: list[SettingsTeam]
    user: SettingsSessionUser
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        default_team_id = self.default_team_id

        is_operator = self.is_operator

        teams = []
        for teams_item_data in self.teams:
            teams_item = teams_item_data.to_dict()
            teams.append(teams_item)

        user = self.user.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "defaultTeamId": default_team_id,
                "isOperator": is_operator,
                "teams": teams,
                "user": user,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.settings_session_user import SettingsSessionUser  # noqa: PLC0415
        from ..models.settings_team import SettingsTeam  # noqa: PLC0415

        d = dict(src_dict)
        default_team_id = d.pop("defaultTeamId")

        is_operator = d.pop("isOperator")

        teams = []
        _teams = d.pop("teams")
        for teams_item_data in _teams:
            teams_item = SettingsTeam.from_dict(teams_item_data)

            teams.append(teams_item)

        user = SettingsSessionUser.from_dict(d.pop("user"))

        settings_session = cls(
            default_team_id=default_team_id,
            is_operator=is_operator,
            teams=teams,
            user=user,
        )

        settings_session.additional_properties = d
        return settings_session

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
