from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MetaSsh")


@_attrs_define
class MetaSsh:
    """
    Attributes:
        host (str):  Example: ssh.example.com.
        host_keys (list[str]): Gateway host keys for known_hosts, "<type> <base64>"
        port (int):
    """

    host: str
    host_keys: list[str]
    port: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        host = self.host

        host_keys = self.host_keys

        port = self.port

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "host": host,
                "hostKeys": host_keys,
                "port": port,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        host = d.pop("host")

        host_keys = cast(list[str], d.pop("hostKeys"))

        port = d.pop("port")

        meta_ssh = cls(
            host=host,
            host_keys=host_keys,
            port=port,
        )

        meta_ssh.additional_properties = d
        return meta_ssh

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
