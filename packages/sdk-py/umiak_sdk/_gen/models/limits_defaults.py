from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LimitsDefaults")


@_attrs_define
class LimitsDefaults:
    """Effective platform lifecycle defaults; null disables the policy. Omitted by older servers.

    Attributes:
        idle_timeout_seconds (int | None):
        ttl_seconds (int | None):
    """

    idle_timeout_seconds: int | None
    ttl_seconds: int | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        idle_timeout_seconds: int | None
        idle_timeout_seconds = self.idle_timeout_seconds

        ttl_seconds: int | None
        ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "idleTimeoutSeconds": idle_timeout_seconds,
                "ttlSeconds": ttl_seconds,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_idle_timeout_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds"))

        def _parse_ttl_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds"))

        limits_defaults = cls(
            idle_timeout_seconds=idle_timeout_seconds,
            ttl_seconds=ttl_seconds,
        )

        limits_defaults.additional_properties = d
        return limits_defaults

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
