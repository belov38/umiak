from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.operation_force_stop_type_0_restart_error_type_0 import (
        OperationForceStopType0RestartErrorType0,
    )


T = TypeVar("T", bound="OperationForceStopType0")


@_attrs_define
class OperationForceStopType0:
    """fork and save_snapshot sent with `forceStop: true` on a running Windows sandbox: the stop and restart of the source;
    null otherwise

        Attributes:
            restart_error (None | OperationForceStopType0RestartErrorType0):
            source_restarted (bool | None): The source was started again; null while that has not happened yet. false: the
                restart failed (see restartError; the sandbox shows the error, resume it), the snapshot is still good
            source_stopped (bool): The source VM was stopped by this operation
    """

    restart_error: None | OperationForceStopType0RestartErrorType0
    source_restarted: bool | None
    source_stopped: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.operation_force_stop_type_0_restart_error_type_0 import (
            OperationForceStopType0RestartErrorType0,  # noqa: PLC0415
        )

        restart_error: dict[str, Any] | None
        if isinstance(self.restart_error, OperationForceStopType0RestartErrorType0):
            restart_error = self.restart_error.to_dict()
        else:
            restart_error = self.restart_error

        source_restarted: bool | None
        source_restarted = self.source_restarted

        source_stopped = self.source_stopped

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "restartError": restart_error,
                "sourceRestarted": source_restarted,
                "sourceStopped": source_stopped,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operation_force_stop_type_0_restart_error_type_0 import (
            OperationForceStopType0RestartErrorType0,  # noqa: PLC0415
        )

        d = dict(src_dict)

        def _parse_restart_error(data: object) -> None | OperationForceStopType0RestartErrorType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                restart_error_type_0 = OperationForceStopType0RestartErrorType0.from_dict(data)

                return restart_error_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | OperationForceStopType0RestartErrorType0, data)

        restart_error = _parse_restart_error(d.pop("restartError"))

        def _parse_source_restarted(data: object) -> bool | None:
            if data is None:
                return data
            return cast(bool | None, data)

        source_restarted = _parse_source_restarted(d.pop("sourceRestarted"))

        source_stopped = d.pop("sourceStopped")

        operation_force_stop_type_0 = cls(
            restart_error=restart_error,
            source_restarted=source_restarted,
            source_stopped=source_stopped,
        )

        operation_force_stop_type_0.additional_properties = d
        return operation_force_stop_type_0

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
