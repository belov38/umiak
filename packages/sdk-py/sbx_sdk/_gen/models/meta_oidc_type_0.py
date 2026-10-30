from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MetaOidcType0")


@_attrs_define
class MetaOidcType0:
    """Keycloak for people (device flow of `sbx login`); null when only team keys work

    Attributes:
        audience (str):  Example: sbx-api.
        client_id (str):  Example: sbx-cli.
        issuer (str):
    """

    audience: str
    client_id: str
    issuer: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        audience = self.audience

        client_id = self.client_id

        issuer = self.issuer

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "audience": audience,
                "clientId": client_id,
                "issuer": issuer,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        audience = d.pop("audience")

        client_id = d.pop("clientId")

        issuer = d.pop("issuer")

        meta_oidc_type_0 = cls(
            audience=audience,
            client_id=client_id,
            issuer=issuer,
        )

        meta_oidc_type_0.additional_properties = d
        return meta_oidc_type_0

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
