from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="CreateSshKeyRequest")


@_attrs_define
class CreateSshKeyRequest:
    """
    Attributes:
        name (str):  Example: laptop.
        public_key (str): OpenSSH public key line: ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa of at least 3072
            bits; not a certificate Example: ssh-ed25519
            AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop.
    """

    name: str
    public_key: str

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        public_key = self.public_key

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
                "publicKey": public_key,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        public_key = d.pop("publicKey")

        create_ssh_key_request = cls(
            name=name,
            public_key=public_key,
        )

        return create_ssh_key_request
