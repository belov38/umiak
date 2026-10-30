from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.operation_kind import OperationKind
from ..models.operation_state import OperationState

if TYPE_CHECKING:
    from ..models.operation_error_type_0 import OperationErrorType0


T = TypeVar("T", bound="SandboxForkSourceOperation")


@_attrs_define
class SandboxForkSourceOperation:
    """
    Attributes:
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        error (None | OperationErrorType0): Why the operation failed; null otherwise
        finished_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        id (str):  Example: op_01jbx2v7d3m6c8q9w0e4r5t6y7.
        kind (OperationKind):
        sandbox_id (str):  Example: sb_01jbx4q3m7f8r2t6v9w0y1z2a3.
        started_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        state (OperationState): pending and running are active; succeeded, failed and superseded are final
        step (None | str): Last completed step, for debugging; values may change
    """

    created_at: datetime.datetime
    error: None | OperationErrorType0
    finished_at: datetime.datetime | None
    id: str
    kind: OperationKind
    sandbox_id: str
    started_at: datetime.datetime | None
    state: OperationState
    step: None | str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.operation_error_type_0 import OperationErrorType0  # noqa: PLC0415

        created_at = self.created_at.isoformat()

        error: dict[str, Any] | None
        if isinstance(self.error, OperationErrorType0):
            error = self.error.to_dict()
        else:
            error = self.error

        finished_at: None | str
        if isinstance(self.finished_at, datetime.datetime):
            finished_at = self.finished_at.isoformat()
        else:
            finished_at = self.finished_at

        id = self.id

        kind = self.kind.value

        sandbox_id = self.sandbox_id

        started_at: None | str
        if isinstance(self.started_at, datetime.datetime):
            started_at = self.started_at.isoformat()
        else:
            started_at = self.started_at

        state = self.state.value

        step: None | str
        step = self.step

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "createdAt": created_at,
                "error": error,
                "finishedAt": finished_at,
                "id": id,
                "kind": kind,
                "sandboxId": sandbox_id,
                "startedAt": started_at,
                "state": state,
                "step": step,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.operation_error_type_0 import OperationErrorType0  # noqa: PLC0415

        d = dict(src_dict)
        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_error(data: object) -> None | OperationErrorType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                error_type_0 = OperationErrorType0.from_dict(data)

                return error_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | OperationErrorType0, data)

        error = _parse_error(d.pop("error"))

        def _parse_finished_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                finished_at_type_0 = datetime.datetime.fromisoformat(data)

                return finished_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        finished_at = _parse_finished_at(d.pop("finishedAt"))

        id = d.pop("id")

        kind = OperationKind(d.pop("kind"))

        sandbox_id = d.pop("sandboxId")

        def _parse_started_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                started_at_type_0 = datetime.datetime.fromisoformat(data)

                return started_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        started_at = _parse_started_at(d.pop("startedAt"))

        state = OperationState(d.pop("state"))

        def _parse_step(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        step = _parse_step(d.pop("step"))

        sandbox_fork_source_operation = cls(
            created_at=created_at,
            error=error,
            finished_at=finished_at,
            id=id,
            kind=kind,
            sandbox_id=sandbox_id,
            started_at=started_at,
            state=state,
            step=step,
        )

        sandbox_fork_source_operation.additional_properties = d
        return sandbox_fork_source_operation

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
