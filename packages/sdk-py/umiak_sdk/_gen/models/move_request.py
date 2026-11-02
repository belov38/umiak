from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="MoveRequest")


@_attrs_define
class MoveRequest:
    """
    Attributes:
        from_ (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too) Example: src/app.py.
        to (str): Absolute, or relative to the home directory of `user` (`~` and `~/...` too) Example: src/app.py.
        overwrite (bool | Unset): Replace an existing destination (default false)
    """

    from_: str
    to: str
    overwrite: bool | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        from_ = self.from_

        to = self.to

        overwrite = self.overwrite

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "from": from_,
                "to": to,
            }
        )
        if overwrite is not UNSET:
            field_dict["overwrite"] = overwrite

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        from_ = d.pop("from")

        to = d.pop("to")

        overwrite = d.pop("overwrite", UNSET)

        move_request = cls(
            from_=from_,
            to=to,
            overwrite=overwrite,
        )

        return move_request
