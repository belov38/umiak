from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="CreateUploadRequest")


@_attrs_define
class CreateUploadRequest:
    """
    Attributes:
        path (str): Destination of the file. Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
    """

    path: str

    def to_dict(self) -> dict[str, Any]:
        path = self.path

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "path": path,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        path = d.pop("path")

        create_upload_request = cls(
            path=path,
        )

        return create_upload_request
