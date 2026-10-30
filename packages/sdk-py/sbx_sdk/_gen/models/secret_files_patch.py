from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.secret_files_patch_additional_property_type_0 import (
        SecretFilesPatchAdditionalPropertyType0,
    )


T = TypeVar("T", bound="SecretFilesPatch")


@_attrs_define
class SecretFilesPatch:
    """Secret files by name: a file replaces the one with that name, null deletes it"""

    additional_properties: dict[str, None | SecretFilesPatchAdditionalPropertyType0] = _attrs_field(
        init=False, factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        from ..models.secret_files_patch_additional_property_type_0 import (
            SecretFilesPatchAdditionalPropertyType0,  # noqa: PLC0415
        )

        field_dict: dict[str, Any] = {}
        for prop_name, prop in self.additional_properties.items():
            if isinstance(prop, SecretFilesPatchAdditionalPropertyType0):
                field_dict[prop_name] = prop.to_dict()
            else:
                field_dict[prop_name] = prop

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.secret_files_patch_additional_property_type_0 import (
            SecretFilesPatchAdditionalPropertyType0,  # noqa: PLC0415
        )

        d = dict(src_dict)
        secret_files_patch = cls()

        additional_properties = {}
        for prop_name, prop_dict in d.items():

            def _parse_additional_property(
                data: object,
            ) -> None | SecretFilesPatchAdditionalPropertyType0:
                if data is None:
                    return data
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    additional_property_type_0 = SecretFilesPatchAdditionalPropertyType0.from_dict(
                        data
                    )

                    return additional_property_type_0
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                return cast(None | SecretFilesPatchAdditionalPropertyType0, data)

            additional_property = _parse_additional_property(prop_dict)

            additional_properties[prop_name] = additional_property

        secret_files_patch.additional_properties = additional_properties
        return secret_files_patch

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> None | SecretFilesPatchAdditionalPropertyType0:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: None | SecretFilesPatchAdditionalPropertyType0) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
