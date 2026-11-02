from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.sandbox_fork_operation import SandboxForkOperation
    from ..models.sandbox_fork_sandbox import SandboxForkSandbox
    from ..models.sandbox_fork_source_operation import SandboxForkSourceOperation


T = TypeVar("T", bound="SandboxFork")


@_attrs_define
class SandboxFork:
    """
    Attributes:
        operation (SandboxForkOperation):
        sandbox (SandboxForkSandbox):
        source_operation (SandboxForkSourceOperation):
    """

    operation: SandboxForkOperation
    sandbox: SandboxForkSandbox
    source_operation: SandboxForkSourceOperation
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        operation = self.operation.to_dict()

        sandbox = self.sandbox.to_dict()

        source_operation = self.source_operation.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "operation": operation,
                "sandbox": sandbox,
                "sourceOperation": source_operation,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sandbox_fork_operation import SandboxForkOperation  # noqa: PLC0415
        from ..models.sandbox_fork_sandbox import SandboxForkSandbox  # noqa: PLC0415
        from ..models.sandbox_fork_source_operation import SandboxForkSourceOperation  # noqa: PLC0415

        d = dict(src_dict)
        operation = SandboxForkOperation.from_dict(d.pop("operation"))

        sandbox = SandboxForkSandbox.from_dict(d.pop("sandbox"))

        source_operation = SandboxForkSourceOperation.from_dict(d.pop("sourceOperation"))

        sandbox_fork = cls(
            operation=operation,
            sandbox=sandbox,
            source_operation=source_operation,
        )

        sandbox_fork.additional_properties = d
        return sandbox_fork

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
