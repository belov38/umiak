from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.limits_templates_item_sizes_item import LimitsTemplatesItemSizesItem


T = TypeVar("T", bound="LimitsTemplatesItem")


@_attrs_define
class LimitsTemplatesItem:
    """
    Attributes:
        default_size (str):
        enabled (bool):
        sizes (list[LimitsTemplatesItemSizesItem]):
        slug (str):
    """

    default_size: str
    enabled: bool
    sizes: list[LimitsTemplatesItemSizesItem]
    slug: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        default_size = self.default_size

        enabled = self.enabled

        sizes = []
        for sizes_item_data in self.sizes:
            sizes_item = sizes_item_data.to_dict()
            sizes.append(sizes_item)

        slug = self.slug

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "defaultSize": default_size,
                "enabled": enabled,
                "sizes": sizes,
                "slug": slug,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.limits_templates_item_sizes_item import LimitsTemplatesItemSizesItem  # noqa: PLC0415

        d = dict(src_dict)
        default_size = d.pop("defaultSize")

        enabled = d.pop("enabled")

        sizes = []
        _sizes = d.pop("sizes")
        for sizes_item_data in _sizes:
            sizes_item = LimitsTemplatesItemSizesItem.from_dict(sizes_item_data)

            sizes.append(sizes_item)

        slug = d.pop("slug")

        limits_templates_item = cls(
            default_size=default_size,
            enabled=enabled,
            sizes=sizes,
            slug=slug,
        )

        limits_templates_item.additional_properties = d
        return limits_templates_item

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
