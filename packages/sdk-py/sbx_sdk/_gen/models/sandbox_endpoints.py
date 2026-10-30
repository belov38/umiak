from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SandboxEndpoints")


@_attrs_define
class SandboxEndpoints:
    """
    Attributes:
        port_url_template (str): URL of a published port; replace {port} Example: https://quiet-otter-
            lamp-{port}.sbx.example.com.
        ssh (str): SSH command (needs a certificate or a registered key) Example: ssh quiet-otter-lamp@ssh.example.com.
    """

    port_url_template: str
    ssh: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        port_url_template = self.port_url_template

        ssh = self.ssh

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "portUrlTemplate": port_url_template,
                "ssh": ssh,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        port_url_template = d.pop("portUrlTemplate")

        ssh = d.pop("ssh")

        sandbox_endpoints = cls(
            port_url_template=port_url_template,
            ssh=ssh,
        )

        sandbox_endpoints.additional_properties = d
        return sandbox_endpoints

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
