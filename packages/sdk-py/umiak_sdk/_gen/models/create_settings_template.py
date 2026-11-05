from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.create_settings_template_capabilities_type_0_item import (
    CreateSettingsTemplateCapabilitiesType0Item,
)
from ..models.create_settings_template_os import CreateSettingsTemplateOs
from ..types import UNSET, Unset

T = TypeVar("T", bound="CreateSettingsTemplate")


@_attrs_define
class CreateSettingsTemplate:
    """
    Attributes:
        allowed_sizes (list[str]):
        default_size (str):
        os (CreateSettingsTemplateOs):
        slug (str):
        capabilities (list[CreateSettingsTemplateCapabilitiesType0Item] | None | Unset):
        description (None | str | Unset):
        enabled (bool | Unset):  Default: True.
        login_user (None | str | Unset):
        name (None | str | Unset):
        sort_order (int | Unset):
    """

    allowed_sizes: list[str]
    default_size: str
    os: CreateSettingsTemplateOs
    slug: str
    capabilities: list[CreateSettingsTemplateCapabilitiesType0Item] | None | Unset = UNSET
    description: None | str | Unset = UNSET
    enabled: bool | Unset = True
    login_user: None | str | Unset = UNSET
    name: None | str | Unset = UNSET
    sort_order: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        allowed_sizes = self.allowed_sizes

        default_size = self.default_size

        os = self.os.value

        slug = self.slug

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

        description: None | str | Unset
        if isinstance(self.description, Unset):
            description = UNSET
        else:
            description = self.description

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

        sort_order = self.sort_order

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "allowedSizes": allowed_sizes,
                "defaultSize": default_size,
                "os": os,
                "slug": slug,
            }
        )
        if capabilities is not UNSET:
            field_dict["capabilities"] = capabilities
        if description is not UNSET:
            field_dict["description"] = description
        if enabled is not UNSET:
            field_dict["enabled"] = enabled
        if login_user is not UNSET:
            field_dict["loginUser"] = login_user
        if name is not UNSET:
            field_dict["name"] = name
        if sort_order is not UNSET:
            field_dict["sortOrder"] = sort_order

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed_sizes = cast(list[str], d.pop("allowedSizes"))

        default_size = d.pop("defaultSize")

        os = CreateSettingsTemplateOs(d.pop("os"))

        slug = d.pop("slug")

        def _parse_capabilities(
            data: object,
        ) -> list[CreateSettingsTemplateCapabilitiesType0Item] | None | Unset:
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
                    capabilities_type_0_item = CreateSettingsTemplateCapabilitiesType0Item(
                        capabilities_type_0_item_data
                    )

                    capabilities_type_0.append(capabilities_type_0_item)

                return capabilities_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[CreateSettingsTemplateCapabilitiesType0Item] | None | Unset, data)

        capabilities = _parse_capabilities(d.pop("capabilities", UNSET))

        def _parse_description(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        description = _parse_description(d.pop("description", UNSET))

        enabled = d.pop("enabled", UNSET)

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

        sort_order = d.pop("sortOrder", UNSET)

        create_settings_template = cls(
            allowed_sizes=allowed_sizes,
            default_size=default_size,
            os=os,
            slug=slug,
            capabilities=capabilities,
            description=description,
            enabled=enabled,
            login_user=login_user,
            name=name,
            sort_order=sort_order,
        )

        return create_settings_template
