from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.file_info_type import FileInfoType

T = TypeVar("T", bound="FileInfo")


@_attrs_define
class FileInfo:
    """A file, directory or symlink

    Attributes:
        gid (int):
        group (str):
        mode (int): Permission bits (0o7777 mask) as a number: 420 = 0644
        modified_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        name (str): Last path component
        owner (str):
        path (str): Absolute path in the sandbox
        size_bytes (int):
        symlink_target (None | str): Target of a symlink; null for other types
        type_ (FileInfoType):
        uid (int):
    """

    gid: int
    group: str
    mode: int
    modified_at: datetime.datetime | None
    name: str
    owner: str
    path: str
    size_bytes: int
    symlink_target: None | str
    type_: FileInfoType
    uid: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        gid = self.gid

        group = self.group

        mode = self.mode

        modified_at: None | str
        if isinstance(self.modified_at, datetime.datetime):
            modified_at = self.modified_at.isoformat()
        else:
            modified_at = self.modified_at

        name = self.name

        owner = self.owner

        path = self.path

        size_bytes = self.size_bytes

        symlink_target: None | str
        symlink_target = self.symlink_target

        type_ = self.type_.value

        uid = self.uid

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "gid": gid,
                "group": group,
                "mode": mode,
                "modifiedAt": modified_at,
                "name": name,
                "owner": owner,
                "path": path,
                "sizeBytes": size_bytes,
                "symlinkTarget": symlink_target,
                "type": type_,
                "uid": uid,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        gid = d.pop("gid")

        group = d.pop("group")

        mode = d.pop("mode")

        def _parse_modified_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                modified_at_type_0 = datetime.datetime.fromisoformat(data)

                return modified_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        modified_at = _parse_modified_at(d.pop("modifiedAt"))

        name = d.pop("name")

        owner = d.pop("owner")

        path = d.pop("path")

        size_bytes = d.pop("sizeBytes")

        def _parse_symlink_target(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        symlink_target = _parse_symlink_target(d.pop("symlinkTarget"))

        type_ = FileInfoType(d.pop("type"))

        uid = d.pop("uid")

        file_info = cls(
            gid=gid,
            group=group,
            mode=mode,
            modified_at=modified_at,
            name=name,
            owner=owner,
            path=path,
            size_bytes=size_bytes,
            symlink_target=symlink_target,
            type_=type_,
            uid=uid,
        )

        file_info.additional_properties = d
        return file_info

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
