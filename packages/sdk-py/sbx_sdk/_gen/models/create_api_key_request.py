from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.create_api_key_request_kind import CreateApiKeyRequestKind
from ..models.create_api_key_request_preset import CreateApiKeyRequestPreset
from ..models.create_api_key_request_scopes_item import CreateApiKeyRequestScopesItem
from ..types import UNSET, Unset

T = TypeVar("T", bound="CreateApiKeyRequest")


@_attrs_define
class CreateApiKeyRequest:
    """
    Attributes:
        name (str):  Example: ci-main.
        expires_in_seconds (int | Unset): Lifetime; default 90 days (7776000), at most 365 days
        kind (CreateApiKeyRequestKind | Unset): Only `team` (the default)
        preset (CreateApiKeyRequestPreset | Unset): read-only, ci or full; or send `scopes`. Exactly one of the two.
        scopes (list[CreateApiKeyRequestScopesItem] | Unset): Scopes of the key; or send `preset`
    """

    name: str
    expires_in_seconds: int | Unset = UNSET
    kind: CreateApiKeyRequestKind | Unset = UNSET
    preset: CreateApiKeyRequestPreset | Unset = UNSET
    scopes: list[CreateApiKeyRequestScopesItem] | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        expires_in_seconds = self.expires_in_seconds

        kind: str | Unset = UNSET
        if not isinstance(self.kind, Unset):
            kind = self.kind.value

        preset: str | Unset = UNSET
        if not isinstance(self.preset, Unset):
            preset = self.preset.value

        scopes: list[str] | Unset = UNSET
        if not isinstance(self.scopes, Unset):
            scopes = []
            for scopes_item_data in self.scopes:
                scopes_item = scopes_item_data.value
                scopes.append(scopes_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
            }
        )
        if expires_in_seconds is not UNSET:
            field_dict["expiresInSeconds"] = expires_in_seconds
        if kind is not UNSET:
            field_dict["kind"] = kind
        if preset is not UNSET:
            field_dict["preset"] = preset
        if scopes is not UNSET:
            field_dict["scopes"] = scopes

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        expires_in_seconds = d.pop("expiresInSeconds", UNSET)

        _kind = d.pop("kind", UNSET)
        kind: CreateApiKeyRequestKind | Unset
        if isinstance(_kind, Unset):
            kind = UNSET
        else:
            kind = CreateApiKeyRequestKind(_kind)

        _preset = d.pop("preset", UNSET)
        preset: CreateApiKeyRequestPreset | Unset
        if isinstance(_preset, Unset):
            preset = UNSET
        else:
            preset = CreateApiKeyRequestPreset(_preset)

        _scopes = d.pop("scopes", UNSET)
        scopes: list[CreateApiKeyRequestScopesItem] | Unset = UNSET
        if _scopes is not UNSET:
            scopes = []
            for scopes_item_data in _scopes:
                scopes_item = CreateApiKeyRequestScopesItem(scopes_item_data)

                scopes.append(scopes_item)

        create_api_key_request = cls(
            name=name,
            expires_in_seconds=expires_in_seconds,
            kind=kind,
            preset=preset,
            scopes=scopes,
        )

        return create_api_key_request
