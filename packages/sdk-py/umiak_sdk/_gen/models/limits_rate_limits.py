from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LimitsRateLimits")


@_attrs_define
class LimitsRateLimits:
    """
    Attributes:
        burst (int):
        requests_per_second (int):
        starts_per_minute (int): create, fork and resume per team
    """

    burst: int
    requests_per_second: int
    starts_per_minute: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        burst = self.burst

        requests_per_second = self.requests_per_second

        starts_per_minute = self.starts_per_minute

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "burst": burst,
                "requestsPerSecond": requests_per_second,
                "startsPerMinute": starts_per_minute,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        burst = d.pop("burst")

        requests_per_second = d.pop("requestsPerSecond")

        starts_per_minute = d.pop("startsPerMinute")

        limits_rate_limits = cls(
            burst=burst,
            requests_per_second=requests_per_second,
            starts_per_minute=starts_per_minute,
        )

        limits_rate_limits.additional_properties = d
        return limits_rate_limits

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
