from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.settings_platform_defaults_rate_limits import SettingsPlatformDefaultsRateLimits
    from ..models.settings_quota import SettingsQuota


T = TypeVar("T", bound="SettingsPlatformDefaults")


@_attrs_define
class SettingsPlatformDefaults:
    """
    Attributes:
        default_quota (SettingsQuota):
        default_template (str):
        error_retention_days (int):
        idle_timeout_seconds (int | None):
        max_owned_teams_per_user (int | None):
        max_ttl_seconds (int):
        new_shared_team_quota (SettingsQuota):
        public_desktop_enabled (bool | None):
        public_ports_enabled (bool | None):
        rate_limits (SettingsPlatformDefaultsRateLimits):
        recover_min_interval_seconds (int):
        stopped_retention_days (int | None):
        ttl_seconds (int | None):
    """

    default_quota: SettingsQuota
    default_template: str
    error_retention_days: int
    idle_timeout_seconds: int | None
    max_owned_teams_per_user: int | None
    max_ttl_seconds: int
    new_shared_team_quota: SettingsQuota
    public_desktop_enabled: bool | None
    public_ports_enabled: bool | None
    rate_limits: SettingsPlatformDefaultsRateLimits
    recover_min_interval_seconds: int
    stopped_retention_days: int | None
    ttl_seconds: int | None

    def to_dict(self) -> dict[str, Any]:
        default_quota = self.default_quota.to_dict()

        default_template = self.default_template

        error_retention_days = self.error_retention_days

        idle_timeout_seconds: int | None
        idle_timeout_seconds = self.idle_timeout_seconds

        max_owned_teams_per_user: int | None
        max_owned_teams_per_user = self.max_owned_teams_per_user

        max_ttl_seconds = self.max_ttl_seconds

        new_shared_team_quota = self.new_shared_team_quota.to_dict()

        public_desktop_enabled: bool | None
        public_desktop_enabled = self.public_desktop_enabled

        public_ports_enabled: bool | None
        public_ports_enabled = self.public_ports_enabled

        rate_limits = self.rate_limits.to_dict()

        recover_min_interval_seconds = self.recover_min_interval_seconds

        stopped_retention_days: int | None
        stopped_retention_days = self.stopped_retention_days

        ttl_seconds: int | None
        ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "defaultQuota": default_quota,
                "defaultTemplate": default_template,
                "errorRetentionDays": error_retention_days,
                "idleTimeoutSeconds": idle_timeout_seconds,
                "maxOwnedTeamsPerUser": max_owned_teams_per_user,
                "maxTtlSeconds": max_ttl_seconds,
                "newSharedTeamQuota": new_shared_team_quota,
                "publicDesktopEnabled": public_desktop_enabled,
                "publicPortsEnabled": public_ports_enabled,
                "rateLimits": rate_limits,
                "recoverMinIntervalSeconds": recover_min_interval_seconds,
                "stoppedRetentionDays": stopped_retention_days,
                "ttlSeconds": ttl_seconds,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.settings_platform_defaults_rate_limits import (
            SettingsPlatformDefaultsRateLimits,  # noqa: PLC0415
        )
        from ..models.settings_quota import SettingsQuota  # noqa: PLC0415

        d = dict(src_dict)
        default_quota = SettingsQuota.from_dict(d.pop("defaultQuota"))

        default_template = d.pop("defaultTemplate")

        error_retention_days = d.pop("errorRetentionDays")

        def _parse_idle_timeout_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds"))

        def _parse_max_owned_teams_per_user(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        max_owned_teams_per_user = _parse_max_owned_teams_per_user(d.pop("maxOwnedTeamsPerUser"))

        max_ttl_seconds = d.pop("maxTtlSeconds")

        new_shared_team_quota = SettingsQuota.from_dict(d.pop("newSharedTeamQuota"))

        def _parse_public_desktop_enabled(data: object) -> bool | None:
            if data is None:
                return data
            return cast(bool | None, data)

        public_desktop_enabled = _parse_public_desktop_enabled(d.pop("publicDesktopEnabled"))

        def _parse_public_ports_enabled(data: object) -> bool | None:
            if data is None:
                return data
            return cast(bool | None, data)

        public_ports_enabled = _parse_public_ports_enabled(d.pop("publicPortsEnabled"))

        rate_limits = SettingsPlatformDefaultsRateLimits.from_dict(d.pop("rateLimits"))

        recover_min_interval_seconds = d.pop("recoverMinIntervalSeconds")

        def _parse_stopped_retention_days(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        stopped_retention_days = _parse_stopped_retention_days(d.pop("stoppedRetentionDays"))

        def _parse_ttl_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds"))

        settings_platform_defaults = cls(
            default_quota=default_quota,
            default_template=default_template,
            error_retention_days=error_retention_days,
            idle_timeout_seconds=idle_timeout_seconds,
            max_owned_teams_per_user=max_owned_teams_per_user,
            max_ttl_seconds=max_ttl_seconds,
            new_shared_team_quota=new_shared_team_quota,
            public_desktop_enabled=public_desktop_enabled,
            public_ports_enabled=public_ports_enabled,
            rate_limits=rate_limits,
            recover_min_interval_seconds=recover_min_interval_seconds,
            stopped_retention_days=stopped_retention_days,
            ttl_seconds=ttl_seconds,
        )

        return settings_platform_defaults
