from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_actions_item_type_1_button import (
    DesktopActBodyActionsItemType1Button,
)
from ..models.desktop_act_body_actions_item_type_1_modifiers_item import (
    DesktopActBodyActionsItemType1ModifiersItem,
)
from ..models.desktop_act_body_actions_item_type_1_type import DesktopActBodyActionsItemType1Type
from ..types import UNSET, Unset

T = TypeVar("T", bound="DesktopActBodyActionsItemType1")


@_attrs_define
class DesktopActBodyActionsItemType1:
    """
    Attributes:
        type_ (DesktopActBodyActionsItemType1Type):
        button (DesktopActBodyActionsItemType1Button | Unset):
        count (int | Unset):
        modifiers (list[DesktopActBodyActionsItemType1ModifiersItem] | Unset):
        x (int | Unset):
        y (int | Unset):
    """

    type_: DesktopActBodyActionsItemType1Type
    button: DesktopActBodyActionsItemType1Button | Unset = UNSET
    count: int | Unset = UNSET
    modifiers: list[DesktopActBodyActionsItemType1ModifiersItem] | Unset = UNSET
    x: int | Unset = UNSET
    y: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        button: str | Unset = UNSET
        if not isinstance(self.button, Unset):
            button = self.button.value

        count = self.count

        modifiers: list[str] | Unset = UNSET
        if not isinstance(self.modifiers, Unset):
            modifiers = []
            for modifiers_item_data in self.modifiers:
                modifiers_item = modifiers_item_data.value
                modifiers.append(modifiers_item)

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
        if count is not UNSET:
            field_dict["count"] = count
        if modifiers is not UNSET:
            field_dict["modifiers"] = modifiers
        if x is not UNSET:
            field_dict["x"] = x
        if y is not UNSET:
            field_dict["y"] = y

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = DesktopActBodyActionsItemType1Type(d.pop("type"))

        _button = d.pop("button", UNSET)
        button: DesktopActBodyActionsItemType1Button | Unset
        if isinstance(_button, Unset):
            button = UNSET
        else:
            button = DesktopActBodyActionsItemType1Button(_button)

        count = d.pop("count", UNSET)

        _modifiers = d.pop("modifiers", UNSET)
        modifiers: list[DesktopActBodyActionsItemType1ModifiersItem] | Unset = UNSET
        if _modifiers is not UNSET:
            modifiers = []
            for modifiers_item_data in _modifiers:
                modifiers_item = DesktopActBodyActionsItemType1ModifiersItem(modifiers_item_data)

                modifiers.append(modifiers_item)

        x = d.pop("x", UNSET)

        y = d.pop("y", UNSET)

        desktop_act_body_actions_item_type_1 = cls(
            type_=type_,
            button=button,
            count=count,
            modifiers=modifiers,
            x=x,
            y=y,
        )

        desktop_act_body_actions_item_type_1.additional_properties = d
        return desktop_act_body_actions_item_type_1

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
