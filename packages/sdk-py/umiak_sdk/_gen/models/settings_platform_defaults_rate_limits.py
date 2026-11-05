from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="SettingsPlatformDefaultsRateLimits")


@_attrs_define
class SettingsPlatformDefaultsRateLimits:
    """
    Attributes:
        burst (int | None):
        requests_per_second (int | None):
        starts_per_minute (int | None):
    """

    burst: int | None
    requests_per_second: int | None
    starts_per_minute: int | None

    def to_dict(self) -> dict[str, Any]:
        burst: int | None
        burst = self.burst

        requests_per_second: int | None
        requests_per_second = self.requests_per_second

        starts_per_minute: int | None
        starts_per_minute = self.starts_per_minute

        field_dict: dict[str, Any] = {}

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

        def _parse_burst(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        burst = _parse_burst(d.pop("burst"))

        def _parse_requests_per_second(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        requests_per_second = _parse_requests_per_second(d.pop("requestsPerSecond"))

        def _parse_starts_per_minute(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        starts_per_minute = _parse_starts_per_minute(d.pop("startsPerMinute"))

        settings_platform_defaults_rate_limits = cls(
            burst=burst,
            requests_per_second=requests_per_second,
            starts_per_minute=starts_per_minute,
        )

        return settings_platform_defaults_rate_limits
