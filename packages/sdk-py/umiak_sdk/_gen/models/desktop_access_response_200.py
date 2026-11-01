from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.desktop_access_response_200_access import DesktopAccessResponse200Access

T = TypeVar("T", bound="DesktopAccessResponse200")


@_attrs_define
class DesktopAccessResponse200:
    """
    Attributes:
        access (DesktopAccessResponse200Access):
        url (str):
    """

    access: DesktopAccessResponse200Access
    url: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        access = self.access.value

        url = self.url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "access": access,
                "url": url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        access = DesktopAccessResponse200Access(d.pop("access"))

        url = d.pop("url")

        desktop_access_response_200 = cls(
            access=access,
            url=url,
        )

        desktop_access_response_200.additional_properties = d
        return desktop_access_response_200

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
