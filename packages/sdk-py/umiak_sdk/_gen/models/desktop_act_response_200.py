from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.desktop_act_response_200_cursor import DesktopActResponse200Cursor
    from ..models.desktop_act_response_200_screen import DesktopActResponse200Screen
    from ..models.desktop_act_response_200_screenshot import DesktopActResponse200Screenshot


T = TypeVar("T", bound="DesktopActResponse200")


@_attrs_define
class DesktopActResponse200:
    """
    Attributes:
        completed (int):
        cursor (DesktopActResponse200Cursor):
        screen (DesktopActResponse200Screen):
        screenshot (DesktopActResponse200Screenshot | Unset):
    """

    completed: int
    cursor: DesktopActResponse200Cursor
    screen: DesktopActResponse200Screen
    screenshot: DesktopActResponse200Screenshot | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        completed = self.completed

        cursor = self.cursor.to_dict()

        screen = self.screen.to_dict()

        screenshot: dict[str, Any] | Unset = UNSET
        if not isinstance(self.screenshot, Unset):
            screenshot = self.screenshot.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "completed": completed,
                "cursor": cursor,
                "screen": screen,
            }
        )
        if screenshot is not UNSET:
            field_dict["screenshot"] = screenshot

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.desktop_act_response_200_cursor import DesktopActResponse200Cursor  # noqa: PLC0415
        from ..models.desktop_act_response_200_screen import DesktopActResponse200Screen  # noqa: PLC0415
        from ..models.desktop_act_response_200_screenshot import DesktopActResponse200Screenshot  # noqa: PLC0415

        d = dict(src_dict)
        completed = d.pop("completed")

        cursor = DesktopActResponse200Cursor.from_dict(d.pop("cursor"))

        screen = DesktopActResponse200Screen.from_dict(d.pop("screen"))

        _screenshot = d.pop("screenshot", UNSET)
        screenshot: DesktopActResponse200Screenshot | Unset
        if isinstance(_screenshot, Unset):
            screenshot = UNSET
        else:
            screenshot = DesktopActResponse200Screenshot.from_dict(_screenshot)

        desktop_act_response_200 = cls(
            completed=completed,
            cursor=cursor,
            screen=screen,
            screenshot=screenshot,
        )

        desktop_act_response_200.additional_properties = d
        return desktop_act_response_200

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
