from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_actions_item_type_0_type import DesktopActBodyActionsItemType0Type

T = TypeVar("T", bound="DesktopActBodyActionsItemType0")


@_attrs_define
class DesktopActBodyActionsItemType0:
    """
    Attributes:
        type_ (DesktopActBodyActionsItemType0Type):
        x (int):
        y (int):
    """

    type_: DesktopActBodyActionsItemType0Type
    x: int
    y: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        x = self.x

        y = self.y

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "x": x,
                "y": y,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = DesktopActBodyActionsItemType0Type(d.pop("type"))

        x = d.pop("x")

        y = d.pop("y")

        desktop_act_body_actions_item_type_0 = cls(
            type_=type_,
            x=x,
            y=y,
        )

        desktop_act_body_actions_item_type_0.additional_properties = d
        return desktop_act_body_actions_item_type_0

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
