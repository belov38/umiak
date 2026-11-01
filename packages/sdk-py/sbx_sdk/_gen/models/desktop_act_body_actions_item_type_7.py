from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_actions_item_type_7_type import DesktopActBodyActionsItemType7Type
from ..types import UNSET, Unset

T = TypeVar("T", bound="DesktopActBodyActionsItemType7")


@_attrs_define
class DesktopActBodyActionsItemType7:
    """
    Attributes:
        text (str):
        type_ (DesktopActBodyActionsItemType7Type):
        delay_ms (int | Unset):
    """

    text: str
    type_: DesktopActBodyActionsItemType7Type
    delay_ms: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        text = self.text

        type_ = self.type_.value

        delay_ms = self.delay_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "text": text,
                "type": type_,
            }
        )
        if delay_ms is not UNSET:
            field_dict["delayMs"] = delay_ms

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        text = d.pop("text")

        type_ = DesktopActBodyActionsItemType7Type(d.pop("type"))

        delay_ms = d.pop("delayMs", UNSET)

        desktop_act_body_actions_item_type_7 = cls(
            text=text,
            type_=type_,
            delay_ms=delay_ms,
        )

        desktop_act_body_actions_item_type_7.additional_properties = d
        return desktop_act_body_actions_item_type_7

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
