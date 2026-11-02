from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.limits_templates_item_sizes_item_reason_type_1 import (
    LimitsTemplatesItemSizesItemReasonType1,
)
from ..models.limits_templates_item_sizes_item_reason_type_2_type_1 import (
    LimitsTemplatesItemSizesItemReasonType2Type1,
)
from ..models.limits_templates_item_sizes_item_reason_type_3_type_1 import (
    LimitsTemplatesItemSizesItemReasonType3Type1,
)

T = TypeVar("T", bound="LimitsTemplatesItemSizesItem")


@_attrs_define
class LimitsTemplatesItemSizesItem:
    """
    Attributes:
        allowed (bool):
        memory_mb (int):
        reason (LimitsTemplatesItemSizesItemReasonType1 | LimitsTemplatesItemSizesItemReasonType2Type1 |
            LimitsTemplatesItemSizesItemReasonType3Type1 | None): Why the size is not allowed now
        slug (str):
        vcpu (int):
    """

    allowed: bool
    memory_mb: int
    reason: (
        LimitsTemplatesItemSizesItemReasonType1
        | LimitsTemplatesItemSizesItemReasonType2Type1
        | LimitsTemplatesItemSizesItemReasonType3Type1
        | None
    )
    slug: str
    vcpu: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        allowed = self.allowed

        memory_mb = self.memory_mb

        reason: None | str
        if isinstance(self.reason, LimitsTemplatesItemSizesItemReasonType1):
            reason = self.reason.value
        elif isinstance(self.reason, LimitsTemplatesItemSizesItemReasonType2Type1):
            reason = self.reason.value
        elif isinstance(self.reason, LimitsTemplatesItemSizesItemReasonType3Type1):
            reason = self.reason.value
        else:
            reason = self.reason

        slug = self.slug

        vcpu = self.vcpu

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "allowed": allowed,
                "memoryMb": memory_mb,
                "reason": reason,
                "slug": slug,
                "vcpu": vcpu,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed = d.pop("allowed")

        memory_mb = d.pop("memoryMb")

        def _parse_reason(
            data: object,
        ) -> (
            LimitsTemplatesItemSizesItemReasonType1
            | LimitsTemplatesItemSizesItemReasonType2Type1
            | LimitsTemplatesItemSizesItemReasonType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                reason_type_1 = LimitsTemplatesItemSizesItemReasonType1(data)

                return reason_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                reason_type_2_type_1 = LimitsTemplatesItemSizesItemReasonType2Type1(data)

                return reason_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                reason_type_3_type_1 = LimitsTemplatesItemSizesItemReasonType3Type1(data)

                return reason_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                LimitsTemplatesItemSizesItemReasonType1
                | LimitsTemplatesItemSizesItemReasonType2Type1
                | LimitsTemplatesItemSizesItemReasonType3Type1
                | None,
                data,
            )

        reason = _parse_reason(d.pop("reason"))

        slug = d.pop("slug")

        vcpu = d.pop("vcpu")

        limits_templates_item_sizes_item = cls(
            allowed=allowed,
            memory_mb=memory_mb,
            reason=reason,
            slug=slug,
            vcpu=vcpu,
        )

        limits_templates_item_sizes_item.additional_properties = d
        return limits_templates_item_sizes_item

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
