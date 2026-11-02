from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="ExtendSandboxRequest")


@_attrs_define
class ExtendSandboxRequest:
    """
    Attributes:
        ttl_seconds (int | Unset): New deadline = now + ttlSeconds; default: the sandbox's TTL
    """

    ttl_seconds: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if ttl_seconds is not UNSET:
            field_dict["ttlSeconds"] = ttl_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        ttl_seconds = d.pop("ttlSeconds", UNSET)

        extend_sandbox_request = cls(
            ttl_seconds=ttl_seconds,
        )

        return extend_sandbox_request
