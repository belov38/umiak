from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.template_os import TemplateOs

T = TypeVar("T", bound="Template")


@_attrs_define
class Template:
    """
    Attributes:
        allowed_sizes (list[str]):
        capabilities (list[str]): What the template supports: exec, files, ssh, desktop
        default_size (str):  Example: 2gb.
        enabled (bool): Disabled templates are listed for operators only
        login_user (str): Guest user of SSH logins Example: user.
        name (str):
        os (TemplateOs):
        slug (str):  Example: linux.
        version (None | str): Version of the active build; null while none is active
    """

    allowed_sizes: list[str]
    capabilities: list[str]
    default_size: str
    enabled: bool
    login_user: str
    name: str
    os: TemplateOs
    slug: str
    version: None | str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        allowed_sizes = self.allowed_sizes

        capabilities = self.capabilities

        default_size = self.default_size

        enabled = self.enabled

        login_user = self.login_user

        name = self.name

        os = self.os.value

        slug = self.slug

        version: None | str
        version = self.version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "allowedSizes": allowed_sizes,
                "capabilities": capabilities,
                "defaultSize": default_size,
                "enabled": enabled,
                "loginUser": login_user,
                "name": name,
                "os": os,
                "slug": slug,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed_sizes = cast(list[str], d.pop("allowedSizes"))

        capabilities = cast(list[str], d.pop("capabilities"))

        default_size = d.pop("defaultSize")

        enabled = d.pop("enabled")

        login_user = d.pop("loginUser")

        name = d.pop("name")

        os = TemplateOs(d.pop("os"))

        slug = d.pop("slug")

        def _parse_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        version = _parse_version(d.pop("version"))

        template = cls(
            allowed_sizes=allowed_sizes,
            capabilities=capabilities,
            default_size=default_size,
            enabled=enabled,
            login_user=login_user,
            name=name,
            os=os,
            slug=slug,
            version=version,
        )

        template.additional_properties = d
        return template

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
