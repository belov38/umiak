from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="ChmodRequest")


@_attrs_define
class ChmodRequest:
    """
    Attributes:
        path (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too) Example: src/app.py.
        group (str | Unset):
        mode (int | Unset):
        owner (str | Unset):
        recursive (bool | Unset): Apply to the directory's contents too (default false)
    """

    path: str
    group: str | Unset = UNSET
    mode: int | Unset = UNSET
    owner: str | Unset = UNSET
    recursive: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        path = self.path

        group = self.group

        mode = self.mode

        owner = self.owner

        recursive = self.recursive

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "path": path,
            }
        )
        if group is not UNSET:
            field_dict["group"] = group
        if mode is not UNSET:
            field_dict["mode"] = mode
        if owner is not UNSET:
            field_dict["owner"] = owner
        if recursive is not UNSET:
            field_dict["recursive"] = recursive

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        path = d.pop("path")

        group = d.pop("group", UNSET)

        mode = d.pop("mode", UNSET)

        owner = d.pop("owner", UNSET)

        recursive = d.pop("recursive", UNSET)

        chmod_request = cls(
            path=path,
            group=group,
            mode=mode,
            owner=owner,
            recursive=recursive,
        )

        return chmod_request
