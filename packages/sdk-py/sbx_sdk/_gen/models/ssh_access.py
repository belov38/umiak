from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SshAccess")


@_attrs_define
class SshAccess:
    """
    Attributes:
        command (str):  Example: ssh quiet-otter-lamp@ssh.example.com.
        has_keys (bool): The person has registered SSH keys (always false for a team key, which uses certificates)
        host (str):  Example: ssh.example.com.
        known_hosts (list[str]): `known_hosts` lines of the gateway host keys, the same for every sandbox (`[host]:port
            ...` when the port is not 22) Example: ['ssh.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'].
        login_user (str): User of the guest OS the session runs as (template) Example: user.
        port (int):  Example: 22.
        username (str): SSH user name: the slug of the sandbox Example: quiet-otter-lamp.
    """

    command: str
    has_keys: bool
    host: str
    known_hosts: list[str]
    login_user: str
    port: int
    username: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command = self.command

        has_keys = self.has_keys

        host = self.host

        known_hosts = self.known_hosts

        login_user = self.login_user

        port = self.port

        username = self.username

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "command": command,
                "hasKeys": has_keys,
                "host": host,
                "knownHosts": known_hosts,
                "loginUser": login_user,
                "port": port,
                "username": username,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        command = d.pop("command")

        has_keys = d.pop("hasKeys")

        host = d.pop("host")

        known_hosts = cast(list[str], d.pop("knownHosts"))

        login_user = d.pop("loginUser")

        port = d.pop("port")

        username = d.pop("username")

        ssh_access = cls(
            command=command,
            has_keys=has_keys,
            host=host,
            known_hosts=known_hosts,
            login_user=login_user,
            port=port,
            username=username,
        )

        ssh_access.additional_properties = d
        return ssh_access

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
