from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.ssh_key_type import SshKeyType

T = TypeVar("T", bound="SshKey")


@_attrs_define
class SshKey:
    """
    Attributes:
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        fingerprint (str): As `ssh-keygen -l`; unique across the platform Example:
            SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.
        id (str):  Example: sshk_01jbx2v7d3m6c8q9w0e4r5t6y7.
        last_used_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        name (str):
        type_ (SshKeyType):
    """

    created_at: datetime.datetime
    fingerprint: str
    id: str
    last_used_at: datetime.datetime | None
    name: str
    type_: SshKeyType
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        created_at = self.created_at.isoformat()

        fingerprint = self.fingerprint

        id = self.id

        last_used_at: None | str
        if isinstance(self.last_used_at, datetime.datetime):
            last_used_at = self.last_used_at.isoformat()
        else:
            last_used_at = self.last_used_at

        name = self.name

        type_ = self.type_.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "createdAt": created_at,
                "fingerprint": fingerprint,
                "id": id,
                "lastUsedAt": last_used_at,
                "name": name,
                "type": type_,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        fingerprint = d.pop("fingerprint")

        id = d.pop("id")

        def _parse_last_used_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                last_used_at_type_0 = datetime.datetime.fromisoformat(data)

                return last_used_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        last_used_at = _parse_last_used_at(d.pop("lastUsedAt"))

        name = d.pop("name")

        type_ = SshKeyType(d.pop("type"))

        ssh_key = cls(
            created_at=created_at,
            fingerprint=fingerprint,
            id=id,
            last_used_at=last_used_at,
            name=name,
            type_=type_,
        )

        ssh_key.additional_properties = d
        return ssh_key

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
