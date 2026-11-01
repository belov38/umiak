from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.me_auth import MeAuth
    from ..models.me_team import MeTeam
    from ..models.me_user_type_0 import MeUserType0


T = TypeVar("T", bound="Me")


@_attrs_define
class Me:
    """
    Attributes:
        auth (MeAuth):
        is_operator (bool): Platform operator rights; only in a browser session
        team (MeTeam): Team of this request (Umiak-Team or the default team)
        teams (list[MeTeam]): Teams of the person; a team key sees only its own team
        user (MeUserType0 | None): The person; null for a team API key
    """

    auth: MeAuth
    is_operator: bool
    team: MeTeam
    teams: list[MeTeam]
    user: MeUserType0 | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.me_user_type_0 import MeUserType0  # noqa: PLC0415

        auth = self.auth.to_dict()

        is_operator = self.is_operator

        team = self.team.to_dict()

        teams = []
        for teams_item_data in self.teams:
            teams_item = teams_item_data.to_dict()
            teams.append(teams_item)

        user: dict[str, Any] | None
        if isinstance(self.user, MeUserType0):
            user = self.user.to_dict()
        else:
            user = self.user

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "auth": auth,
                "isOperator": is_operator,
                "team": team,
                "teams": teams,
                "user": user,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.me_auth import MeAuth  # noqa: PLC0415
        from ..models.me_team import MeTeam  # noqa: PLC0415
        from ..models.me_user_type_0 import MeUserType0  # noqa: PLC0415

        d = dict(src_dict)
        auth = MeAuth.from_dict(d.pop("auth"))

        is_operator = d.pop("isOperator")

        team = MeTeam.from_dict(d.pop("team"))

        teams = []
        _teams = d.pop("teams")
        for teams_item_data in _teams:
            teams_item = MeTeam.from_dict(teams_item_data)

            teams.append(teams_item)

        def _parse_user(data: object) -> MeUserType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                user_type_0 = MeUserType0.from_dict(data)

                return user_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MeUserType0 | None, data)

        user = _parse_user(d.pop("user"))

        me = cls(
            auth=auth,
            is_operator=is_operator,
            team=team,
            teams=teams,
            user=user,
        )

        me.additional_properties = d
        return me

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
