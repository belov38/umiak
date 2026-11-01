from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandKillRequest")


@_attrs_define
class CommandKillRequest:
    """
    Attributes:
        grace_ms (int | Unset): SIGTERM, then SIGKILL after this many ms (default 10 000)
    """

    grace_ms: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        grace_ms = self.grace_ms

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if grace_ms is not UNSET:
            field_dict["graceMs"] = grace_ms

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        grace_ms = d.pop("graceMs", UNSET)

        command_kill_request = cls(
            grace_ms=grace_ms,
        )

        return command_kill_request
