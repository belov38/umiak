from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.operation import Operation
    from ..models.sandbox import Sandbox


T = TypeVar("T", bound="SandboxAction")


@_attrs_define
class SandboxAction:
    """The sandbox now and the operation that was started

    Attributes:
        operation (Operation): A long-running action on a sandbox; wait with GET /v1/operations/{operation}?waitSeconds=
        sandbox (Sandbox): A VM sandbox. Work with it while `state` is `ready`; deleted sandboxes stay readable for 30
            days
    """

    operation: Operation
    sandbox: Sandbox
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        operation = self.operation.to_dict()

        sandbox = self.sandbox.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "operation": operation,
                "sandbox": sandbox,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operation import Operation  # noqa: PLC0415
        from ..models.sandbox import Sandbox  # noqa: PLC0415

        d = dict(src_dict)
        operation = Operation.from_dict(d.pop("operation"))

        sandbox = Sandbox.from_dict(d.pop("sandbox"))

        sandbox_action = cls(
            operation=operation,
            sandbox=sandbox,
        )

        sandbox_action.additional_properties = d
        return sandbox_action

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
