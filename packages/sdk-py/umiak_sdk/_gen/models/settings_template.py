from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.settings_template_os import SettingsTemplateOs

T = TypeVar("T", bound="SettingsTemplate")


@_attrs_define
class SettingsTemplate:
    """
    Attributes:
        allowed_sizes (list[str]):
        capabilities (list[str] | None):
        default_size (str):
        description (None | str):
        enabled (bool | None):
        login_user (None | str):
        name (None | str):
        os (SettingsTemplateOs):
        slug (str):
        sort_order (float | None):
    """

    allowed_sizes: list[str]
    capabilities: list[str] | None
    default_size: str
    description: None | str
    enabled: bool | None
    login_user: None | str
    name: None | str
    os: SettingsTemplateOs
    slug: str
    sort_order: float | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        allowed_sizes = self.allowed_sizes

        capabilities: list[str] | None
        if isinstance(self.capabilities, list):
            capabilities = self.capabilities

        else:
            capabilities = self.capabilities

        default_size = self.default_size

        description: None | str
        description = self.description

        enabled: bool | None
        enabled = self.enabled

        login_user: None | str
        login_user = self.login_user

        name: None | str
        name = self.name

        os = self.os.value

        slug = self.slug

        sort_order: float | None
        sort_order = self.sort_order

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "allowedSizes": allowed_sizes,
                "capabilities": capabilities,
                "defaultSize": default_size,
                "description": description,
                "enabled": enabled,
                "loginUser": login_user,
                "name": name,
                "os": os,
                "slug": slug,
                "sortOrder": sort_order,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed_sizes = cast(list[str], d.pop("allowedSizes"))

        def _parse_capabilities(data: object) -> list[str] | None:
            if data is None:
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                capabilities_type_0 = cast(list[str], data)

                return capabilities_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[str] | None, data)

        capabilities = _parse_capabilities(d.pop("capabilities"))

        default_size = d.pop("defaultSize")

        def _parse_description(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        description = _parse_description(d.pop("description"))

        def _parse_enabled(data: object) -> bool | None:
            if data is None:
                return data
            return cast(bool | None, data)

        enabled = _parse_enabled(d.pop("enabled"))

        def _parse_login_user(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        login_user = _parse_login_user(d.pop("loginUser"))

        def _parse_name(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        name = _parse_name(d.pop("name"))

        os = SettingsTemplateOs(d.pop("os"))

        slug = d.pop("slug")

        def _parse_sort_order(data: object) -> float | None:
            if data is None:
                return data
            return cast(float | None, data)

        sort_order = _parse_sort_order(d.pop("sortOrder"))

        settings_template = cls(
            allowed_sizes=allowed_sizes,
            capabilities=capabilities,
            default_size=default_size,
            description=description,
            enabled=enabled,
            login_user=login_user,
            name=name,
            os=os,
            slug=slug,
            sort_order=sort_order,
        )

        settings_template.additional_properties = d
        return settings_template

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
