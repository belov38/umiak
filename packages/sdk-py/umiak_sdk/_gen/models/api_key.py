from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.api_key_created_via import ApiKeyCreatedVia
from ..models.api_key_kind import ApiKeyKind
from ..models.api_key_scopes_item import ApiKeyScopesItem

if TYPE_CHECKING:
    from ..models.api_key_created_by_type_0 import ApiKeyCreatedByType0


T = TypeVar("T", bound="ApiKey")


@_attrs_define
class ApiKey:
    """
    Attributes:
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        created_by (ApiKeyCreatedByType0 | None): Who issued the key (audit only; the key does not depend on them)
        created_via (ApiKeyCreatedVia):
        expires_at (datetime.datetime): ISO 8601 UTC with milliseconds
        id (str):  Example: key_01jbx2v7d3m6c8q9w0e4r5t6y7.
        kind (ApiKeyKind): Always `team` in v1; `sandbox` is reserved
        last4 (str):  Example: 9xYz.
        last_used_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        name (str):
        prefix (str): First 8 characters after `umiak_` Example: a1B2c3D4.
        revoked_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        sandbox_id (None | str): Sandbox keys only (reserved); null
        scopes (list[ApiKeyScopesItem]):
        team_id (str):  Example: team_01jbx2v7d3m6c8q9w0e4r5t6y7.
    """

    created_at: datetime.datetime
    created_by: ApiKeyCreatedByType0 | None
    created_via: ApiKeyCreatedVia
    expires_at: datetime.datetime
    id: str
    kind: ApiKeyKind
    last4: str
    last_used_at: datetime.datetime | None
    name: str
    prefix: str
    revoked_at: datetime.datetime | None
    sandbox_id: None | str
    scopes: list[ApiKeyScopesItem]
    team_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.api_key_created_by_type_0 import ApiKeyCreatedByType0  # noqa: PLC0415

        created_at = self.created_at.isoformat()

        created_by: dict[str, Any] | None
        if isinstance(self.created_by, ApiKeyCreatedByType0):
            created_by = self.created_by.to_dict()
        else:
            created_by = self.created_by

        created_via = self.created_via.value

        expires_at = self.expires_at.isoformat()

        id = self.id

        kind = self.kind.value

        last4 = self.last4

        last_used_at: None | str
        if isinstance(self.last_used_at, datetime.datetime):
            last_used_at = self.last_used_at.isoformat()
        else:
            last_used_at = self.last_used_at

        name = self.name

        prefix = self.prefix

        revoked_at: None | str
        if isinstance(self.revoked_at, datetime.datetime):
            revoked_at = self.revoked_at.isoformat()
        else:
            revoked_at = self.revoked_at

        sandbox_id: None | str
        sandbox_id = self.sandbox_id

        scopes = []
        for scopes_item_data in self.scopes:
            scopes_item = scopes_item_data.value
            scopes.append(scopes_item)

        team_id = self.team_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "createdAt": created_at,
                "createdBy": created_by,
                "createdVia": created_via,
                "expiresAt": expires_at,
                "id": id,
                "kind": kind,
                "last4": last4,
                "lastUsedAt": last_used_at,
                "name": name,
                "prefix": prefix,
                "revokedAt": revoked_at,
                "sandboxId": sandbox_id,
                "scopes": scopes,
                "teamId": team_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.api_key_created_by_type_0 import ApiKeyCreatedByType0  # noqa: PLC0415

        d = dict(src_dict)
        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_created_by(data: object) -> ApiKeyCreatedByType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                created_by_type_0 = ApiKeyCreatedByType0.from_dict(data)

                return created_by_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(ApiKeyCreatedByType0 | None, data)

        created_by = _parse_created_by(d.pop("createdBy"))

        created_via = ApiKeyCreatedVia(d.pop("createdVia"))

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        id = d.pop("id")

        kind = ApiKeyKind(d.pop("kind"))

        last4 = d.pop("last4")

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

        prefix = d.pop("prefix")

        def _parse_revoked_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                revoked_at_type_0 = datetime.datetime.fromisoformat(data)

                return revoked_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        revoked_at = _parse_revoked_at(d.pop("revokedAt"))

        def _parse_sandbox_id(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        sandbox_id = _parse_sandbox_id(d.pop("sandboxId"))

        scopes = []
        _scopes = d.pop("scopes")
        for scopes_item_data in _scopes:
            scopes_item = ApiKeyScopesItem(scopes_item_data)

            scopes.append(scopes_item)

        team_id = d.pop("teamId")

        api_key = cls(
            created_at=created_at,
            created_by=created_by,
            created_via=created_via,
            expires_at=expires_at,
            id=id,
            kind=kind,
            last4=last4,
            last_used_at=last_used_at,
            name=name,
            prefix=prefix,
            revoked_at=revoked_at,
            sandbox_id=sandbox_id,
            scopes=scopes,
            team_id=team_id,
        )

        api_key.additional_properties = d
        return api_key

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
