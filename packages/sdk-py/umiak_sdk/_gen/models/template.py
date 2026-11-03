from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.template_os import TemplateOs
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.template_availability_item import TemplateAvailabilityItem


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
        availability (list[TemplateAvailabilityItem] | Unset): Per-node local template availability; does not guarantee
            free RAM
        build_created_at (datetime.datetime | None | Unset): Creation date of the active build
        pve_vmid (int | None | Unset): VMID of the active sealed template
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
    availability: list[TemplateAvailabilityItem] | Unset = UNSET
    build_created_at: datetime.datetime | None | Unset = UNSET
    pve_vmid: int | None | Unset = UNSET
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

        availability: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.availability, Unset):
            availability = []
            for availability_item_data in self.availability:
                availability_item = availability_item_data.to_dict()
                availability.append(availability_item)

        build_created_at: None | str | Unset
        if isinstance(self.build_created_at, Unset):
            build_created_at = UNSET
        elif isinstance(self.build_created_at, datetime.datetime):
            build_created_at = self.build_created_at.isoformat()
        else:
            build_created_at = self.build_created_at

        pve_vmid: int | None | Unset
        if isinstance(self.pve_vmid, Unset):
            pve_vmid = UNSET
        else:
            pve_vmid = self.pve_vmid

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
        if availability is not UNSET:
            field_dict["availability"] = availability
        if build_created_at is not UNSET:
            field_dict["buildCreatedAt"] = build_created_at
        if pve_vmid is not UNSET:
            field_dict["pveVmid"] = pve_vmid

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.template_availability_item import TemplateAvailabilityItem  # noqa: PLC0415

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

        _availability = d.pop("availability", UNSET)
        availability: list[TemplateAvailabilityItem] | Unset = UNSET
        if _availability is not UNSET:
            availability = []
            for availability_item_data in _availability:
                availability_item = TemplateAvailabilityItem.from_dict(availability_item_data)

                availability.append(availability_item)

        def _parse_build_created_at(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                build_created_at_type_0 = datetime.datetime.fromisoformat(data)

                return build_created_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        build_created_at = _parse_build_created_at(d.pop("buildCreatedAt", UNSET))

        def _parse_pve_vmid(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        pve_vmid = _parse_pve_vmid(d.pop("pveVmid", UNSET))

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
            availability=availability,
            build_created_at=build_created_at,
            pve_vmid=pve_vmid,
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
