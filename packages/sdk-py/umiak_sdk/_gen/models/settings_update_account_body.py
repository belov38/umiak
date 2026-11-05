from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="SettingsUpdateAccountBody")


@_attrs_define
class SettingsUpdateAccountBody:
    """
    Attributes:
        default_team_id (str):
    """

    default_team_id: str

    def to_dict(self) -> dict[str, Any]:
        default_team_id = self.default_team_id

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "defaultTeamId": default_team_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        default_team_id = d.pop("defaultTeamId")

        settings_update_account_body = cls(
            default_team_id=default_team_id,
        )

        return settings_update_account_body
