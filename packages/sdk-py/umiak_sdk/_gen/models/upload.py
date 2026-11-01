from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="Upload")


@_attrs_define
class Upload:
    """
    Attributes:
        chunk_size_bytes (int): Recommended chunk size (4 MiB) Example: 4194304.
        expires_at (datetime.datetime): The partial upload is dropped after 24 h without activity
        max_chunk_size_bytes (int): Largest accepted chunk (8 MiB); larger is 413 Example: 8388608.
        upload_id (str):  Example: upl_01jbx2v7d3m6c8q9w0e4r5t6y7.
    """

    chunk_size_bytes: int
    expires_at: datetime.datetime
    max_chunk_size_bytes: int
    upload_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chunk_size_bytes = self.chunk_size_bytes

        expires_at = self.expires_at.isoformat()

        max_chunk_size_bytes = self.max_chunk_size_bytes

        upload_id = self.upload_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chunkSizeBytes": chunk_size_bytes,
                "expiresAt": expires_at,
                "maxChunkSizeBytes": max_chunk_size_bytes,
                "uploadId": upload_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        chunk_size_bytes = d.pop("chunkSizeBytes")

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        max_chunk_size_bytes = d.pop("maxChunkSizeBytes")

        upload_id = d.pop("uploadId")

        upload = cls(
            chunk_size_bytes=chunk_size_bytes,
            expires_at=expires_at,
            max_chunk_size_bytes=max_chunk_size_bytes,
            upload_id=upload_id,
        )

        upload.additional_properties = d
        return upload

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
