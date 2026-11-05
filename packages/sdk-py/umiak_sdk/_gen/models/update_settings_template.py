from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.update_settings_template_capabilities_type_0_item import (
    UpdateSettingsTemplateCapabilitiesType0Item,
)
from ..models.update_settings_template_os import UpdateSettingsTemplateOs
from ..types import UNSET, Unset

T = TypeVar("T", bound="UpdateSettingsTemplate")


@_attrs_define
class UpdateSettingsTemplate:
    """
    Attributes:
        allowed_sizes (list[str] | Unset):
        capabilities (list[UpdateSettingsTemplateCapabilitiesType0Item] | None | Unset):
        default_size (str | Unset):
        description (None | str | Unset):
        enabled (bool | None | Unset):
        login_user (None | str | Unset):
        name (None | str | Unset):
        os (UpdateSettingsTemplateOs | Unset):
        sort_order (int | None | Unset):
    """

    allowed_sizes: list[str] | Unset = UNSET
    capabilities: list[UpdateSettingsTemplateCapabilitiesType0Item] | None | Unset = UNSET
    default_size: str | Unset = UNSET
    description: None | str | Unset = UNSET
    enabled: bool | None | Unset = UNSET
    login_user: None | str | Unset = UNSET
    name: None | str | Unset = UNSET
    os: UpdateSettingsTemplateOs | Unset = UNSET
    sort_order: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        allowed_sizes: list[str] | Unset = UNSET
        if not isinstance(self.allowed_sizes, Unset):
            allowed_sizes = self.allowed_sizes

        capabilities: list[str] | None | Unset
        if isinstance(self.capabilities, Unset):
            capabilities = UNSET
        elif isinstance(self.capabilities, list):
            capabilities = []
            for capabilities_type_0_item_data in self.capabilities:
                capabilities_type_0_item = capabilities_type_0_item_data.value
                capabilities.append(capabilities_type_0_item)

        else:
            capabilities = self.capabilities

        default_size = self.default_size

        description: None | str | Unset
        if isinstance(self.description, Unset):
            description = UNSET
        else:
            description = self.description

        enabled: bool | None | Unset
        if isinstance(self.enabled, Unset):
            enabled = UNSET
        else:
            enabled = self.enabled

        login_user: None | str | Unset
        if isinstance(self.login_user, Unset):
            login_user = UNSET
        else:
            login_user = self.login_user

        name: None | str | Unset
        if isinstance(self.name, Unset):
            name = UNSET
        else:
            name = self.name

        os: str | Unset = UNSET
        if not isinstance(self.os, Unset):
            os = self.os.value

        sort_order: int | None | Unset
        if isinstance(self.sort_order, Unset):
            sort_order = UNSET
        else:
            sort_order = self.sort_order

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if allowed_sizes is not UNSET:
            field_dict["allowedSizes"] = allowed_sizes
        if capabilities is not UNSET:
            field_dict["capabilities"] = capabilities
        if default_size is not UNSET:
            field_dict["defaultSize"] = default_size
        if description is not UNSET:
            field_dict["description"] = description
        if enabled is not UNSET:
            field_dict["enabled"] = enabled
        if login_user is not UNSET:
            field_dict["loginUser"] = login_user
        if name is not UNSET:
            field_dict["name"] = name
        if os is not UNSET:
            field_dict["os"] = os
        if sort_order is not UNSET:
            field_dict["sortOrder"] = sort_order

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed_sizes = cast(list[str], d.pop("allowedSizes", UNSET))

        def _parse_capabilities(
            data: object,
        ) -> list[UpdateSettingsTemplateCapabilitiesType0Item] | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                capabilities_type_0 = []
                _capabilities_type_0 = data
                for capabilities_type_0_item_data in _capabilities_type_0:
                    capabilities_type_0_item = UpdateSettingsTemplateCapabilitiesType0Item(
                        capabilities_type_0_item_data
                    )

                    capabilities_type_0.append(capabilities_type_0_item)

                return capabilities_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[UpdateSettingsTemplateCapabilitiesType0Item] | None | Unset, data)

        capabilities = _parse_capabilities(d.pop("capabilities", UNSET))

        default_size = d.pop("defaultSize", UNSET)

        def _parse_description(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        description = _parse_description(d.pop("description", UNSET))

        def _parse_enabled(data: object) -> bool | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(bool | None | Unset, data)

        enabled = _parse_enabled(d.pop("enabled", UNSET))

        def _parse_login_user(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        login_user = _parse_login_user(d.pop("loginUser", UNSET))

        def _parse_name(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        name = _parse_name(d.pop("name", UNSET))

        _os = d.pop("os", UNSET)
        os: UpdateSettingsTemplateOs | Unset
        if isinstance(_os, Unset):
            os = UNSET
        else:
            os = UpdateSettingsTemplateOs(_os)

        def _parse_sort_order(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        sort_order = _parse_sort_order(d.pop("sortOrder", UNSET))

        update_settings_template = cls(
            allowed_sizes=allowed_sizes,
            capabilities=capabilities,
            default_size=default_size,
            description=description,
            enabled=enabled,
            login_user=login_user,
            name=name,
            os=os,
            sort_order=sort_order,
        )

        return update_settings_template
