from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="MakeDirRequest")


@_attrs_define
class MakeDirRequest:
    """
    Attributes:
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too) Example: src/app.py.
        mode (int | Unset): Directory mode (default 493 = 0755)
        parents (bool | Unset): Create missing parents too (default false)
    """

    path: str
    mode: int | Unset = UNSET
    parents: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        path = self.path

        mode = self.mode

        parents = self.parents

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "path": path,
            }
        )
        if mode is not UNSET:
            field_dict["mode"] = mode
        if parents is not UNSET:
            field_dict["parents"] = parents

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        path = d.pop("path")

        mode = d.pop("mode", UNSET)

        parents = d.pop("parents", UNSET)

        make_dir_request = cls(
            path=path,
            mode=mode,
            parents=parents,
        )

        return make_dir_request
