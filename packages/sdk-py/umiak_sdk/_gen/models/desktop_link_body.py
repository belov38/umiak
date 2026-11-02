from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_link_body_fps_type_0 import DesktopLinkBodyFpsType0
from ..models.desktop_link_body_fps_type_1 import DesktopLinkBodyFpsType1
from ..models.desktop_link_body_transport import DesktopLinkBodyTransport
from ..types import UNSET, Unset

T = TypeVar("T", bound="DesktopLinkBody")


@_attrs_define
class DesktopLinkBody:
    """
    Attributes:
        bitrate_kbps (int | Unset):
        fps (DesktopLinkBodyFpsType0 | DesktopLinkBodyFpsType1 | Unset):
        transport (DesktopLinkBodyTransport | Unset):
    """

    bitrate_kbps: int | Unset = UNSET
    fps: DesktopLinkBodyFpsType0 | DesktopLinkBodyFpsType1 | Unset = UNSET
    transport: DesktopLinkBodyTransport | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        bitrate_kbps = self.bitrate_kbps

        fps: int | Unset
        if isinstance(self.fps, Unset):
            fps = UNSET
        elif isinstance(self.fps, DesktopLinkBodyFpsType0):
            fps = self.fps.value
        else:
            fps = self.fps.value

        transport: str | Unset = UNSET
        if not isinstance(self.transport, Unset):
            transport = self.transport.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if bitrate_kbps is not UNSET:
            field_dict["bitrateKbps"] = bitrate_kbps
        if fps is not UNSET:
            field_dict["fps"] = fps
        if transport is not UNSET:
            field_dict["transport"] = transport

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        bitrate_kbps = d.pop("bitrateKbps", UNSET)

        def _parse_fps(data: object) -> DesktopLinkBodyFpsType0 | DesktopLinkBodyFpsType1 | Unset:
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, int):
                    raise TypeError()
                fps_type_0 = DesktopLinkBodyFpsType0(data)

                return fps_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            fps_type_1 = DesktopLinkBodyFpsType1(data)

            return fps_type_1

        fps = _parse_fps(d.pop("fps", UNSET))

        _transport = d.pop("transport", UNSET)
        transport: DesktopLinkBodyTransport | Unset
        if isinstance(_transport, Unset):
            transport = UNSET
        else:
            transport = DesktopLinkBodyTransport(_transport)

        desktop_link_body = cls(
            bitrate_kbps=bitrate_kbps,
            fps=fps,
            transport=transport,
        )

        desktop_link_body.additional_properties = d
        return desktop_link_body

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
