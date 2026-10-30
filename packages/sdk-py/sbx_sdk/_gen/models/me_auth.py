from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.me_auth_kind import MeAuthKind
from ..models.me_auth_scopes_item import MeAuthScopesItem
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.me_auth_created_by_type_0 import MeAuthCreatedByType0


T = TypeVar("T", bound="MeAuth")


@_attrs_define
class MeAuth:
    """
    Attributes:
        kind (MeAuthKind):
        scopes (list[MeAuthScopesItem]):
        api_key_id (str | Unset): Team keys only Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.
        created_by (MeAuthCreatedByType0 | None | Unset): Team keys only: who issued the key (audit)
        expires_at (datetime.datetime | Unset): Expiry of the key or the access token; absent for browser sessions
    """

    kind: MeAuthKind
    scopes: list[MeAuthScopesItem]
    api_key_id: str | Unset = UNSET
    created_by: MeAuthCreatedByType0 | None | Unset = UNSET
    expires_at: datetime.datetime | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.me_auth_created_by_type_0 import MeAuthCreatedByType0  # noqa: PLC0415

        kind = self.kind.value

        scopes = []
        for scopes_item_data in self.scopes:
            scopes_item = scopes_item_data.value
            scopes.append(scopes_item)

        api_key_id = self.api_key_id

        created_by: dict[str, Any] | None | Unset
        if isinstance(self.created_by, Unset):
            created_by = UNSET
        elif isinstance(self.created_by, MeAuthCreatedByType0):
            created_by = self.created_by.to_dict()
        else:
            created_by = self.created_by

        expires_at: str | Unset = UNSET
        if not isinstance(self.expires_at, Unset):
            expires_at = self.expires_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "kind": kind,
                "scopes": scopes,
            }
        )
        if api_key_id is not UNSET:
            field_dict["apiKeyId"] = api_key_id
        if created_by is not UNSET:
            field_dict["createdBy"] = created_by
        if expires_at is not UNSET:
            field_dict["expiresAt"] = expires_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.me_auth_created_by_type_0 import MeAuthCreatedByType0  # noqa: PLC0415

        d = dict(src_dict)
        kind = MeAuthKind(d.pop("kind"))

        scopes = []
        _scopes = d.pop("scopes")
        for scopes_item_data in _scopes:
            scopes_item = MeAuthScopesItem(scopes_item_data)

            scopes.append(scopes_item)

        api_key_id = d.pop("apiKeyId", UNSET)

        def _parse_created_by(data: object) -> MeAuthCreatedByType0 | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_by_type_0 = MeAuthCreatedByType0.from_dict(data)

                return created_by_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MeAuthCreatedByType0 | None | Unset, data)

        created_by = _parse_created_by(d.pop("createdBy", UNSET))

        _expires_at = d.pop("expiresAt", UNSET)
        expires_at: datetime.datetime | Unset
        if isinstance(_expires_at, Unset):
            expires_at = UNSET
        else:
            expires_at = datetime.datetime.fromisoformat(_expires_at)

        me_auth = cls(
            kind=kind,
            scopes=scopes,
            api_key_id=api_key_id,
            created_by=created_by,
            expires_at=expires_at,
        )

        me_auth.additional_properties = d
        return me_auth

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
