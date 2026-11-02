from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="CreateSandboxRequestFrom")


@_attrs_define
class CreateSandboxRequestFrom:
    """Create from a saved snapshot of the team (needs snapshots:read)

    Attributes:
        snapshot (str):  Example: web-stack.
    """

    snapshot: str

    def to_dict(self) -> dict[str, Any]:
        snapshot = self.snapshot

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "snapshot": snapshot,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        snapshot = d.pop("snapshot")

        create_sandbox_request_from = cls(
            snapshot=snapshot,
        )

        return create_sandbox_request_from
