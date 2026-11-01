from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="SecretFilesPatchAdditionalPropertyType0")


@_attrs_define
class SecretFilesPatchAdditionalPropertyType0:
    """
    Attributes:
        content_base_64 (str): File content, base64 (up to 1 MiB decoded)
        link_path (str | Unset): Absolute path of a symlink to the file in the guest Example:
            /home/user/.config/gcloud/key.json.
        mode (int | Unset): File mode (default 0440 = 288) Example: 288.
    """

    content_base_64: str
    link_path: str | Unset = UNSET
    mode: int | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        content_base_64 = self.content_base_64

        link_path = self.link_path

        mode = self.mode

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "contentBase64": content_base_64,
            }
        )
        if link_path is not UNSET:
            field_dict["linkPath"] = link_path
        if mode is not UNSET:
            field_dict["mode"] = mode

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        content_base_64 = d.pop("contentBase64")

        link_path = d.pop("linkPath", UNSET)

        mode = d.pop("mode", UNSET)

        secret_files_patch_additional_property_type_0 = cls(
            content_base_64=content_base_64,
            link_path=link_path,
            mode=mode,
        )

        return secret_files_patch_additional_property_type_0
