from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ListeningPort")


@_attrs_define
class ListeningPort:
    """A TCP port a process in the guest listens on

    Attributes:
        addresses (list[str]):
        port (int):
        process (str):
        user (str):
    """

    addresses: list[str]
    port: int
    process: str
    user: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        addresses = self.addresses

        port = self.port

        process = self.process

        user = self.user

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "addresses": addresses,
                "port": port,
                "process": process,
                "user": user,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        addresses = cast(list[str], d.pop("addresses"))

        port = d.pop("port")

        process = d.pop("process")

        user = d.pop("user")

        listening_port = cls(
            addresses=addresses,
            port=port,
            process=process,
            user=user,
        )

        listening_port.additional_properties = d
        return listening_port

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
