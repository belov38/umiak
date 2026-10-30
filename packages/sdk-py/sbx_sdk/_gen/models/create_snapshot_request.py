from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="CreateSnapshotRequest")


@_attrs_define
class CreateSnapshotRequest:
    """A ready snapshot with this name is replaced once the new one is ready

    Attributes:
        name (str): Name within the team: `^[a-z0-9][a-z0-9-]{0,62}$` Example: web-stack.
        sandbox (str): Source sandbox: id (`sb_...`) or slug Example: quiet-otter-lamp.
    """

    name: str
    sandbox: str

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        sandbox = self.sandbox

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
                "sandbox": sandbox,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        sandbox = d.pop("sandbox")

        create_snapshot_request = cls(
            name=name,
            sandbox=sandbox,
        )

        return create_snapshot_request
