from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.api_key import ApiKey


T = TypeVar("T", bound="ApiKeySecret")


@_attrs_define
class ApiKeySecret:
    """
    Attributes:
        api_key (ApiKey):
        secret (str): The secret (`umiak_...`), shown only in this answer; keep it like a password
    """

    api_key: ApiKey
    secret: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        api_key = self.api_key.to_dict()

        secret = self.secret

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "apiKey": api_key,
                "secret": secret,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.api_key import ApiKey  # noqa: PLC0415

        d = dict(src_dict)
        api_key = ApiKey.from_dict(d.pop("apiKey"))

        secret = d.pop("secret")

        api_key_secret = cls(
            api_key=api_key,
            secret=secret,
        )

        api_key_secret.additional_properties = d
        return api_key_secret

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
