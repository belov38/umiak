from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.error_error_details import ErrorErrorDetails


T = TypeVar("T", bound="ErrorError")


@_attrs_define
class ErrorError:
    """
    Attributes:
        code (str): Stable snake_case error code; new codes may be added within v1 Example: operation_in_progress.
        details (ErrorErrorDetails): Code-specific details; may be empty
        message (str): What happened and what to do next, in English
        request_id (str):  Example: req_01jbx2v7d3m6c8q9w0e4r5t6y7.
        retryable (bool): Repeating the same request is safe and may succeed later
    """

    code: str
    details: ErrorErrorDetails
    message: str
    request_id: str
    retryable: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code

        details = self.details.to_dict()

        message = self.message

        request_id = self.request_id

        retryable = self.retryable

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "details": details,
                "message": message,
                "requestId": request_id,
                "retryable": retryable,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.error_error_details import ErrorErrorDetails  # noqa: PLC0415

        d = dict(src_dict)
        code = d.pop("code")

        details = ErrorErrorDetails.from_dict(d.pop("details"))

        message = d.pop("message")

        request_id = d.pop("requestId")

        retryable = d.pop("retryable")

        error_error = cls(
            code=code,
            details=details,
            message=message,
            request_id=request_id,
            retryable=retryable,
        )

        error_error.additional_properties = d
        return error_error

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
