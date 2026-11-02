from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="EnvVarsPatch")


@_attrs_define
class EnvVarsPatch:
    """Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without NUL, 256 KiB per set. `UMIAK_`
    is reserved except UMIAK_API_KEY, UMIAK_API_URL, UMIAK_TEAM, UMIAK_PROFILE. Values with a newline are not visible in
    SSH sessions. Merged by key: null deletes the key.

    """

    additional_properties: dict[str, None | str] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:

        field_dict: dict[str, Any] = {}
        for prop_name, prop in self.additional_properties.items():
            field_dict[prop_name] = prop

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        env_vars_patch = cls()

        additional_properties = {}
        for prop_name, prop_dict in d.items():

            def _parse_additional_property(data: object) -> None | str:
                if data is None:
                    return data
                return cast(None | str, data)

            additional_property = _parse_additional_property(prop_dict)

            additional_properties[prop_name] = additional_property

        env_vars_patch.additional_properties = additional_properties
        return env_vars_patch

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> None | str:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: None | str) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
