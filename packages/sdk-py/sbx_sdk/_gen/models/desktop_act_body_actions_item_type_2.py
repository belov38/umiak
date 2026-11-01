from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_actions_item_type_2_button import (
    DesktopActBodyActionsItemType2Button,
)
from ..models.desktop_act_body_actions_item_type_2_type import DesktopActBodyActionsItemType2Type
from ..types import UNSET, Unset

T = TypeVar("T", bound="DesktopActBodyActionsItemType2")


@_attrs_define
class DesktopActBodyActionsItemType2:
    """
    Attributes:
        type_ (DesktopActBodyActionsItemType2Type):
        button (DesktopActBodyActionsItemType2Button | Unset):
        x (int | Unset):
        y (int | Unset):
    """

    type_: DesktopActBodyActionsItemType2Type
    button: DesktopActBodyActionsItemType2Button | Unset = UNSET
    x: int | Unset = UNSET
    y: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        button: str | Unset = UNSET
        if not isinstance(self.button, Unset):
            button = self.button.value

        x = self.x

        y = self.y

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
            }
        )
        if button is not UNSET:
            field_dict["button"] = button
        if x is not UNSET:
            field_dict["x"] = x
        if y is not UNSET:
            field_dict["y"] = y

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = DesktopActBodyActionsItemType2Type(d.pop("type"))

        _button = d.pop("button", UNSET)
        button: DesktopActBodyActionsItemType2Button | Unset
        if isinstance(_button, Unset):
            button = UNSET
        else:
            button = DesktopActBodyActionsItemType2Button(_button)

        x = d.pop("x", UNSET)

        y = d.pop("y", UNSET)

        desktop_act_body_actions_item_type_2 = cls(
            type_=type_,
            button=button,
            x=x,
            y=y,
        )

        desktop_act_body_actions_item_type_2.additional_properties = d
        return desktop_act_body_actions_item_type_2

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
