from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_act_response_200_screenshot_content_type import (
    DesktopActResponse200ScreenshotContentType,
)

T = TypeVar("T", bound="DesktopActResponse200Screenshot")


@_attrs_define
class DesktopActResponse200Screenshot:
    """
    Attributes:
        content_type (DesktopActResponse200ScreenshotContentType):
        data (str):
        height (int):
        width (int):
    """

    content_type: DesktopActResponse200ScreenshotContentType
    data: str
    height: int
    width: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        content_type = self.content_type.value

        data = self.data

        height = self.height

        width = self.width

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "contentType": content_type,
                "data": data,
                "height": height,
                "width": width,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        content_type = DesktopActResponse200ScreenshotContentType(d.pop("contentType"))

        data = d.pop("data")

        height = d.pop("height")

        width = d.pop("width")

        desktop_act_response_200_screenshot = cls(
            content_type=content_type,
            data=data,
            height=height,
            width=width,
        )

        desktop_act_response_200_screenshot.additional_properties = d
        return desktop_act_response_200_screenshot

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
