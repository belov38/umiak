from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="ResizePtyRequest")


@_attrs_define
class ResizePtyRequest:
    """
    Attributes:
        cols (int):  Example: 120.
        rows (int):  Example: 32.
    """

    cols: int
    rows: int

    def to_dict(self) -> dict[str, Any]:
        cols = self.cols

        rows = self.rows

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "cols": cols,
                "rows": rows,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        cols = d.pop("cols")

        rows = d.pop("rows")

        resize_pty_request = cls(
            cols=cols,
            rows=rows,
        )

        return resize_pty_request
