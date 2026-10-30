from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.limits_quota import LimitsQuota
    from ..models.limits_rate_limits import LimitsRateLimits
    from ..models.limits_remaining import LimitsRemaining
    from ..models.limits_templates_item import LimitsTemplatesItem
    from ..models.limits_usage import LimitsUsage


T = TypeVar("T", bound="Limits")


@_attrs_define
class Limits:
    """Quota of the request's team and what it can create; node capacity is not promised

    Attributes:
        can_create (bool): A sandbox of at least one allowed size fits the quota now
        quota (LimitsQuota):
        rate_limits (LimitsRateLimits):
        remaining (LimitsRemaining):
        templates (list[LimitsTemplatesItem]):
        usage (LimitsUsage): Counted like the quota: sandboxes and their RAM while creating, ready, starting or
            stopping; saved snapshots creating or ready
    """

    can_create: bool
    quota: LimitsQuota
    rate_limits: LimitsRateLimits
    remaining: LimitsRemaining
    templates: list[LimitsTemplatesItem]
    usage: LimitsUsage
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        can_create = self.can_create

        quota = self.quota.to_dict()

        rate_limits = self.rate_limits.to_dict()

        remaining = self.remaining.to_dict()

        templates = []
        for templates_item_data in self.templates:
            templates_item = templates_item_data.to_dict()
            templates.append(templates_item)

        usage = self.usage.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "canCreate": can_create,
                "quota": quota,
                "rateLimits": rate_limits,
                "remaining": remaining,
                "templates": templates,
                "usage": usage,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.limits_quota import LimitsQuota  # noqa: PLC0415
        from ..models.limits_rate_limits import LimitsRateLimits  # noqa: PLC0415
        from ..models.limits_remaining import LimitsRemaining  # noqa: PLC0415
        from ..models.limits_templates_item import LimitsTemplatesItem  # noqa: PLC0415
        from ..models.limits_usage import LimitsUsage  # noqa: PLC0415

        d = dict(src_dict)
        can_create = d.pop("canCreate")

        quota = LimitsQuota.from_dict(d.pop("quota"))

        rate_limits = LimitsRateLimits.from_dict(d.pop("rateLimits"))

        remaining = LimitsRemaining.from_dict(d.pop("remaining"))

        templates = []
        _templates = d.pop("templates")
        for templates_item_data in _templates:
            templates_item = LimitsTemplatesItem.from_dict(templates_item_data)

            templates.append(templates_item)

        usage = LimitsUsage.from_dict(d.pop("usage"))

        limits = cls(
            can_create=can_create,
            quota=quota,
            rate_limits=rate_limits,
            remaining=remaining,
            templates=templates,
            usage=usage,
        )

        limits.additional_properties = d
        return limits

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
