from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.block_request_reason import BlockRequestReason
from ..types import UNSET, Unset

T = TypeVar("T", bound="BlockRequest")


@_attrs_define
class BlockRequest:
    """
    Attributes:
        reason (BlockRequestReason):
        note (str | Unset): Up to 500 characters for the record (the sandbox's events)
    """

    reason: BlockRequestReason
    note: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        reason = self.reason.value

        note = self.note

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "reason": reason,
            }
        )
        if note is not UNSET:
            field_dict["note"] = note

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        reason = BlockRequestReason(d.pop("reason"))

        note = d.pop("note", UNSET)

        block_request = cls(
            reason=reason,
            note=note,
        )

        return block_request
