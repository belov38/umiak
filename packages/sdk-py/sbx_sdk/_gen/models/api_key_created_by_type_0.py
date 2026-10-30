from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ApiKeyCreatedByType0")


@_attrs_define
class ApiKeyCreatedByType0:
    """Who issued the key (audit only; the key does not depend on them)

    Attributes:
        active (bool): false: the creator is deactivated
        email (str):
        id (str):  Example: usr_01jbx2v7d3m6c8q9w0e4r5t6y7.
        member (bool): false: the creator left the team (the key still works)
    """

    active: bool
    email: str
    id: str
    member: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        active = self.active

        email = self.email

        id = self.id

        member = self.member

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "active": active,
                "email": email,
                "id": id,
                "member": member,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        active = d.pop("active")

        email = d.pop("email")

        id = d.pop("id")

        member = d.pop("member")

        api_key_created_by_type_0 = cls(
            active=active,
            email=email,
            id=id,
            member=member,
        )

        api_key_created_by_type_0.additional_properties = d
        return api_key_created_by_type_0

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
