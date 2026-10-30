from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="UnblockRequest")


@_attrs_define
class UnblockRequest:
    """
    Attributes:
        note (str | Unset): Up to 500 characters for the record (the sandbox's events)
    """

    note: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        note = self.note

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if note is not UNSET:
            field_dict["note"] = note

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        note = d.pop("note", UNSET)

        unblock_request = cls(
            note=note,
        )

        return unblock_request
