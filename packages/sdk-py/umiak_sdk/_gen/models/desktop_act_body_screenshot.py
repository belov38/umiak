from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_body_screenshot_format import DesktopActBodyScreenshotFormat
from ..types import UNSET, Unset

T = TypeVar("T", bound="DesktopActBodyScreenshot")


@_attrs_define
class DesktopActBodyScreenshot:
    """
    Attributes:
        format_ (DesktopActBodyScreenshotFormat | Unset):
        max_height (int | Unset):
        max_width (int | Unset):
        quality (int | Unset):
    """

    format_: DesktopActBodyScreenshotFormat | Unset = UNSET
    max_height: int | Unset = UNSET
    max_width: int | Unset = UNSET
    quality: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        format_: str | Unset = UNSET
        if not isinstance(self.format_, Unset):
            format_ = self.format_.value

        max_height = self.max_height

        max_width = self.max_width

        quality = self.quality

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if format_ is not UNSET:
            field_dict["format"] = format_
        if max_height is not UNSET:
            field_dict["maxHeight"] = max_height
        if max_width is not UNSET:
            field_dict["maxWidth"] = max_width
        if quality is not UNSET:
            field_dict["quality"] = quality

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _format_ = d.pop("format", UNSET)
        format_: DesktopActBodyScreenshotFormat | Unset
        if isinstance(_format_, Unset):
            format_ = UNSET
        else:
            format_ = DesktopActBodyScreenshotFormat(_format_)

        max_height = d.pop("maxHeight", UNSET)

        max_width = d.pop("maxWidth", UNSET)

        quality = d.pop("quality", UNSET)

        desktop_act_body_screenshot = cls(
            format_=format_,
            max_height=max_height,
            max_width=max_width,
            quality=quality,
        )

        desktop_act_body_screenshot.additional_properties = d
        return desktop_act_body_screenshot

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
