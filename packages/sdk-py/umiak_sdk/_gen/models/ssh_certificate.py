from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SshCertificate")


@_attrs_define
class SshCertificate:
    """
    Attributes:
        certificate (str): OpenSSH user certificate line; save it next to the private key as `<key>-cert.pub`
        host (str):  Example: ssh.example.com.
        known_hosts (list[str]): `known_hosts` lines of the gateway host keys, the same for every sandbox (`[host]:port
            ...` when the port is not 22) Example: ['ssh.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'].
        port (int):  Example: 22.
        principal (str): The only principal: the sandbox id Example: sb_01jbx2v7d3m6c8q9w0e4r5t6y7.
        username (str): SSH user name: the slug of the sandbox Example: quiet-otter-lamp.
        valid_after (datetime.datetime): ISO 8601 UTC with milliseconds
        valid_before (datetime.datetime): Checked only when logging in: an open session lasts longer
    """

    certificate: str
    host: str
    known_hosts: list[str]
    port: int
    principal: str
    username: str
    valid_after: datetime.datetime
    valid_before: datetime.datetime
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        certificate = self.certificate

        host = self.host

        known_hosts = self.known_hosts

        port = self.port

        principal = self.principal

        username = self.username

        valid_after = self.valid_after.isoformat()

        valid_before = self.valid_before.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "certificate": certificate,
                "host": host,
                "knownHosts": known_hosts,
                "port": port,
                "principal": principal,
                "username": username,
                "validAfter": valid_after,
                "validBefore": valid_before,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        certificate = d.pop("certificate")

        host = d.pop("host")

        known_hosts = cast(list[str], d.pop("knownHosts"))

        port = d.pop("port")

        principal = d.pop("principal")

        username = d.pop("username")

        valid_after = datetime.datetime.fromisoformat(d.pop("validAfter"))

        valid_before = datetime.datetime.fromisoformat(d.pop("validBefore"))

        ssh_certificate = cls(
            certificate=certificate,
            host=host,
            known_hosts=known_hosts,
            port=port,
            principal=principal,
            username=username,
            valid_after=valid_after,
            valid_before=valid_before,
        )

        ssh_certificate.additional_properties = d
        return ssh_certificate

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
