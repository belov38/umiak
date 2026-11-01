from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="CreateSnapshotRequest")


@_attrs_define
class CreateSnapshotRequest:
    """A ready snapshot with this name is replaced once the new one is ready

    Attributes:
        name (str): Name within the team: `^[a-z0-9][a-z0-9-]{0,62}$` Example: web-stack.
        sandbox (str): Source sandbox: id (`sb_...`) or slug Example: quiet-otter-lamp.
        force_stop (bool | Unset): Windows only: a running Windows sandbox is snapshotted from a stopped VM. With true,
            the source is stopped (running commands, sessions and connections end), snapshotted and started again; the
            operation's `forceStop` reports the restart. Without it, a running Windows source answers 409
            `snapshot_requires_stop`. Ignored for Linux (snapshotted while running) and for a stopped source.
    """

    name: str
    sandbox: str
    force_stop: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        sandbox = self.sandbox

        force_stop = self.force_stop

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "name": name,
                "sandbox": sandbox,
            }
        )
        if force_stop is not UNSET:
            field_dict["forceStop"] = force_stop

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name")

        sandbox = d.pop("sandbox")

        force_stop = d.pop("forceStop", UNSET)

        create_snapshot_request = cls(
            name=name,
            sandbox=sandbox,
            force_stop=force_stop,
        )

        return create_snapshot_request
