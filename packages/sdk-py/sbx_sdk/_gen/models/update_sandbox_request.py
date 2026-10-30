from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.update_sandbox_request_labels import UpdateSandboxRequestLabels


T = TypeVar("T", bound="UpdateSandboxRequest")


@_attrs_define
class UpdateSandboxRequest:
    """
    Attributes:
        idle_timeout_seconds (int | None | Unset): Stop after this many idle seconds (at least 60); null disables idle-
            stop
        labels (UpdateSandboxRequestLabels | Unset):
        name (None | str | Unset): Display name, up to 255 characters Example: ci-run-42.
        slug (str | Unset): New slug; published port URLs and their cookies change at once
        ttl_seconds (int | None | Unset): New TTL: deadline = now + ttl on a ready sandbox; null removes it
    """

    idle_timeout_seconds: int | None | Unset = UNSET
    labels: UpdateSandboxRequestLabels | Unset = UNSET
    name: None | str | Unset = UNSET
    slug: str | Unset = UNSET
    ttl_seconds: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        idle_timeout_seconds: int | None | Unset
        if isinstance(self.idle_timeout_seconds, Unset):
            idle_timeout_seconds = UNSET
        else:
            idle_timeout_seconds = self.idle_timeout_seconds

        labels: dict[str, Any] | Unset = UNSET
        if not isinstance(self.labels, Unset):
            labels = self.labels.to_dict()

        name: None | str | Unset
        if isinstance(self.name, Unset):
            name = UNSET
        else:
            name = self.name

        slug = self.slug

        ttl_seconds: int | None | Unset
        if isinstance(self.ttl_seconds, Unset):
            ttl_seconds = UNSET
        else:
            ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if idle_timeout_seconds is not UNSET:
            field_dict["idleTimeoutSeconds"] = idle_timeout_seconds
        if labels is not UNSET:
            field_dict["labels"] = labels
        if name is not UNSET:
            field_dict["name"] = name
        if slug is not UNSET:
            field_dict["slug"] = slug
        if ttl_seconds is not UNSET:
            field_dict["ttlSeconds"] = ttl_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.update_sandbox_request_labels import UpdateSandboxRequestLabels  # noqa: PLC0415

        d = dict(src_dict)

        def _parse_idle_timeout_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds", UNSET))

        _labels = d.pop("labels", UNSET)
        labels: UpdateSandboxRequestLabels | Unset
        if isinstance(_labels, Unset):
            labels = UNSET
        else:
            labels = UpdateSandboxRequestLabels.from_dict(_labels)

        def _parse_name(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        name = _parse_name(d.pop("name", UNSET))

        slug = d.pop("slug", UNSET)

        def _parse_ttl_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds", UNSET))

        update_sandbox_request = cls(
            idle_timeout_seconds=idle_timeout_seconds,
            labels=labels,
            name=name,
            slug=slug,
            ttl_seconds=ttl_seconds,
        )

        return update_sandbox_request
