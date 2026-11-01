from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_status_response_200_access import DesktopStatusResponse200Access
from ..models.desktop_status_response_200_state import DesktopStatusResponse200State

if TYPE_CHECKING:
    from ..models.desktop_status_response_200_cursor import DesktopStatusResponse200Cursor
    from ..models.desktop_status_response_200_screen import DesktopStatusResponse200Screen
    from ..models.desktop_status_response_200_streamer import DesktopStatusResponse200Streamer


T = TypeVar("T", bound="DesktopStatusResponse200")


@_attrs_define
class DesktopStatusResponse200:
    """
    Attributes:
        access (DesktopStatusResponse200Access):
        cursor (DesktopStatusResponse200Cursor):
        reason (None | str):
        screen (DesktopStatusResponse200Screen):
        state (DesktopStatusResponse200State):
        streamer (DesktopStatusResponse200Streamer):
        url (str):
    """

    access: DesktopStatusResponse200Access
    cursor: DesktopStatusResponse200Cursor
    reason: None | str
    screen: DesktopStatusResponse200Screen
    state: DesktopStatusResponse200State
    streamer: DesktopStatusResponse200Streamer
    url: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        access = self.access.value

        cursor = self.cursor.to_dict()

        reason: None | str
        reason = self.reason

        screen = self.screen.to_dict()

        state = self.state.value

        streamer = self.streamer.to_dict()

        url = self.url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "access": access,
                "cursor": cursor,
                "reason": reason,
                "screen": screen,
                "state": state,
                "streamer": streamer,
                "url": url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.desktop_status_response_200_cursor import DesktopStatusResponse200Cursor  # noqa: PLC0415
        from ..models.desktop_status_response_200_screen import DesktopStatusResponse200Screen  # noqa: PLC0415
        from ..models.desktop_status_response_200_streamer import DesktopStatusResponse200Streamer  # noqa: PLC0415

        d = dict(src_dict)
        access = DesktopStatusResponse200Access(d.pop("access"))

        cursor = DesktopStatusResponse200Cursor.from_dict(d.pop("cursor"))

        def _parse_reason(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        reason = _parse_reason(d.pop("reason"))

        screen = DesktopStatusResponse200Screen.from_dict(d.pop("screen"))

        state = DesktopStatusResponse200State(d.pop("state"))

        streamer = DesktopStatusResponse200Streamer.from_dict(d.pop("streamer"))

        url = d.pop("url")

        desktop_status_response_200 = cls(
            access=access,
            cursor=cursor,
            reason=reason,
            screen=screen,
            state=state,
            streamer=streamer,
            url=url,
        )

        desktop_status_response_200.additional_properties = d
        return desktop_status_response_200

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
