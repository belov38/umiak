from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="CommitUploadRequest")


@_attrs_define
class CommitUploadRequest:
    """
    Attributes:
        path (str): Destination of the file. Absolute, or relative to the home directory of `user` (`~` and `~/...` too)
            Example: src/app.py.
        make_parents (bool | Unset): Create missing parent directories (default true)
        mode (int | Unset): File mode (default 420 = 0644)
        overwrite (bool | Unset): Replace an existing file (default true)
        owner (str | Unset): Owner of the file (default `user`)
        sha256 (str | Unset): Hex SHA-256 of the whole file; a mismatch is 422 checksum_mismatch and drops the upload
    """

    path: str
    make_parents: bool | Unset = UNSET
    mode: int | Unset = UNSET
    overwrite: bool | Unset = UNSET
    owner: str | Unset = UNSET
    sha256: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        path = self.path

        make_parents = self.make_parents

        mode = self.mode

        overwrite = self.overwrite

        owner = self.owner

        sha256 = self.sha256

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "path": path,
            }
        )
        if make_parents is not UNSET:
            field_dict["makeParents"] = make_parents
        if mode is not UNSET:
            field_dict["mode"] = mode
        if overwrite is not UNSET:
            field_dict["overwrite"] = overwrite
        if owner is not UNSET:
            field_dict["owner"] = owner
        if sha256 is not UNSET:
            field_dict["sha256"] = sha256

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        path = d.pop("path")

        make_parents = d.pop("makeParents", UNSET)

        mode = d.pop("mode", UNSET)

        overwrite = d.pop("overwrite", UNSET)

        owner = d.pop("owner", UNSET)

        sha256 = d.pop("sha256", UNSET)

        commit_upload_request = cls(
            path=path,
            make_parents=make_parents,
            mode=mode,
            overwrite=overwrite,
            owner=owner,
            sha256=sha256,
        )

        return commit_upload_request
