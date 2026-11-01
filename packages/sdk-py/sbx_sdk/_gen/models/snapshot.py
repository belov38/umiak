from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.snapshot_consistency_type_1 import SnapshotConsistencyType1
from ..models.snapshot_consistency_type_2_type_1 import SnapshotConsistencyType2Type1
from ..models.snapshot_consistency_type_3_type_1 import SnapshotConsistencyType3Type1
from ..models.snapshot_state import SnapshotState

if TYPE_CHECKING:
    from ..models.snapshot_error_type_0 import SnapshotErrorType0


T = TypeVar("T", bound="Snapshot")


@_attrs_define
class Snapshot:
    """A saved snapshot; create a sandbox from it with POST /v1/sandboxes {from: {snapshot: name}}

    Attributes:
        consistency (None | SnapshotConsistencyType1 | SnapshotConsistencyType2Type1 | SnapshotConsistencyType3Type1):
            quiesced: filesystems frozen in a running VM; powered_off: taken from a VM stopped by a clean guest shutdown;
            crash: disks as after a power loss (a Linux VM after a hard stop, or an older Windows snapshot); null until
            ready
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        error (None | SnapshotErrorType0): Why it failed; null otherwise
        id (str):  Example: snap_01jbx2v7d3m6c8q9w0e4r5t6y7.
        name (str): The name; while creating, the name it will get Example: web-stack.
        ready_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        size (None | str):  Example: 2gb.
        source_sandbox_id (None | str): The sandbox it was taken from (`sb_...`)
        state (SnapshotState):
        template (None | str):
        template_version (None | str):
    """

    consistency: (
        None
        | SnapshotConsistencyType1
        | SnapshotConsistencyType2Type1
        | SnapshotConsistencyType3Type1
    )
    created_at: datetime.datetime
    error: None | SnapshotErrorType0
    id: str
    name: str
    ready_at: datetime.datetime | None
    size: None | str
    source_sandbox_id: None | str
    state: SnapshotState
    template: None | str
    template_version: None | str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.snapshot_error_type_0 import SnapshotErrorType0  # noqa: PLC0415

        consistency: None | str
        if isinstance(self.consistency, SnapshotConsistencyType1):
            consistency = self.consistency.value
        elif isinstance(self.consistency, SnapshotConsistencyType2Type1):
            consistency = self.consistency.value
        elif isinstance(self.consistency, SnapshotConsistencyType3Type1):
            consistency = self.consistency.value
        else:
            consistency = self.consistency

        created_at = self.created_at.isoformat()

        error: dict[str, Any] | None
        if isinstance(self.error, SnapshotErrorType0):
            error = self.error.to_dict()
        else:
            error = self.error

        id = self.id

        name = self.name

        ready_at: None | str
        if isinstance(self.ready_at, datetime.datetime):
            ready_at = self.ready_at.isoformat()
        else:
            ready_at = self.ready_at

        size: None | str
        size = self.size

        source_sandbox_id: None | str
        source_sandbox_id = self.source_sandbox_id

        state = self.state.value

        template: None | str
        template = self.template

        template_version: None | str
        template_version = self.template_version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "consistency": consistency,
                "createdAt": created_at,
                "error": error,
                "id": id,
                "name": name,
                "readyAt": ready_at,
                "size": size,
                "sourceSandboxId": source_sandbox_id,
                "state": state,
                "template": template,
                "templateVersion": template_version,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.snapshot_error_type_0 import SnapshotErrorType0  # noqa: PLC0415

        d = dict(src_dict)

        def _parse_consistency(
            data: object,
        ) -> (
            None
            | SnapshotConsistencyType1
            | SnapshotConsistencyType2Type1
            | SnapshotConsistencyType3Type1
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                consistency_type_1 = SnapshotConsistencyType1(data)

                return consistency_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                consistency_type_2_type_1 = SnapshotConsistencyType2Type1(data)

                return consistency_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                consistency_type_3_type_1 = SnapshotConsistencyType3Type1(data)

                return consistency_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                None
                | SnapshotConsistencyType1
                | SnapshotConsistencyType2Type1
                | SnapshotConsistencyType3Type1,
                data,
            )

        consistency = _parse_consistency(d.pop("consistency"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_error(data: object) -> None | SnapshotErrorType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                error_type_0 = SnapshotErrorType0.from_dict(data)

                return error_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | SnapshotErrorType0, data)

        error = _parse_error(d.pop("error"))

        id = d.pop("id")

        name = d.pop("name")

        def _parse_ready_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                ready_at_type_0 = datetime.datetime.fromisoformat(data)

                return ready_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        ready_at = _parse_ready_at(d.pop("readyAt"))

        def _parse_size(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        size = _parse_size(d.pop("size"))

        def _parse_source_sandbox_id(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        source_sandbox_id = _parse_source_sandbox_id(d.pop("sourceSandboxId"))

        state = SnapshotState(d.pop("state"))

        def _parse_template(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        template = _parse_template(d.pop("template"))

        def _parse_template_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        template_version = _parse_template_version(d.pop("templateVersion"))

        snapshot = cls(
            consistency=consistency,
            created_at=created_at,
            error=error,
            id=id,
            name=name,
            ready_at=ready_at,
            size=size,
            source_sandbox_id=source_sandbox_id,
            state=state,
            template=template,
            template_version=template_version,
        )

        snapshot.additional_properties = d
        return snapshot

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
