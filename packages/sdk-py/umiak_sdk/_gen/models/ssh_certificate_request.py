from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="SshCertificateRequest")


@_attrs_define
class SshCertificateRequest:
    """
    Attributes:
        public_key (str): OpenSSH public key line: ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa of at least 3072
            bits; not a certificate Example: ssh-ed25519
            AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop.
    """

    public_key: str

    def to_dict(self) -> dict[str, Any]:
        public_key = self.public_key

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "publicKey": public_key,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        public_key = d.pop("publicKey")

        ssh_certificate_request = cls(
            public_key=public_key,
        )

        return ssh_certificate_request
