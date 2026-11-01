from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_actions_item_type_6_type import DesktopActBodyActionsItemType6Type

T = TypeVar("T", bound="DesktopActBodyActionsItemType6")


@_attrs_define
class DesktopActBodyActionsItemType6:
    """
    Attributes:
        key (str):
        type_ (DesktopActBodyActionsItemType6Type):
    """

    key: str
    type_: DesktopActBodyActionsItemType6Type
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        key = self.key

        type_ = self.type_.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "key": key,
                "type": type_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        key = d.pop("key")

        type_ = DesktopActBodyActionsItemType6Type(d.pop("type"))

        desktop_act_body_actions_item_type_6 = cls(
            key=key,
            type_=type_,
        )

        desktop_act_body_actions_item_type_6.additional_properties = d
        return desktop_act_body_actions_item_type_6

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
