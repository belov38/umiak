from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="TemplateAvailabilityItem")


@_attrs_define
class TemplateAvailabilityItem:
    """
    Attributes:
        available (bool):
        node_id (UUID):
        node_name (str):
        pve_vmid (int | None):
        version (None | str):
    """

    available: bool
    node_id: UUID
    node_name: str
    pve_vmid: int | None
    version: None | str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        available = self.available

        node_id = str(self.node_id)

        node_name = self.node_name

        pve_vmid: int | None
        pve_vmid = self.pve_vmid

        version: None | str
        version = self.version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "available": available,
                "nodeId": node_id,
                "nodeName": node_name,
                "pveVmid": pve_vmid,
                "version": version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        available = d.pop("available")

        node_id = UUID(d.pop("nodeId"))

        node_name = d.pop("nodeName")

        def _parse_pve_vmid(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        pve_vmid = _parse_pve_vmid(d.pop("pveVmid"))

        def _parse_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        version = _parse_version(d.pop("version"))

        template_availability_item = cls(
            available=available,
            node_id=node_id,
            node_name=node_name,
            pve_vmid=pve_vmid,
            version=version,
        )

        template_availability_item.additional_properties = d
        return template_availability_item

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
