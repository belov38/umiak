from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.operation_progress_phase import OperationProgressPhase
from ..types import UNSET, Unset

T = TypeVar("T", bound="OperationProgress")


@_attrs_define
class OperationProgress:
    """Portable data transfer or capacity queue progress; no credentials or request bodies

    Attributes:
        phase (OperationProgressPhase):
        queued_until (datetime.datetime | None | Unset): ISO 8601 UTC with milliseconds
        target_node (str | Unset):
        total_bytes (float | Unset):
        verified_bytes (float | Unset):
    """

    phase: OperationProgressPhase
    queued_until: datetime.datetime | None | Unset = UNSET
    target_node: str | Unset = UNSET
    total_bytes: float | Unset = UNSET
    verified_bytes: float | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        phase = self.phase.value

        queued_until: None | str | Unset
        if isinstance(self.queued_until, Unset):
            queued_until = UNSET
        elif isinstance(self.queued_until, datetime.datetime):
            queued_until = self.queued_until.isoformat()
        else:
            queued_until = self.queued_until

        target_node = self.target_node

        total_bytes = self.total_bytes

        verified_bytes = self.verified_bytes

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "phase": phase,
            }
        )
        if queued_until is not UNSET:
            field_dict["queuedUntil"] = queued_until
        if target_node is not UNSET:
            field_dict["targetNode"] = target_node
        if total_bytes is not UNSET:
            field_dict["totalBytes"] = total_bytes
        if verified_bytes is not UNSET:
            field_dict["verifiedBytes"] = verified_bytes

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        phase = OperationProgressPhase(d.pop("phase"))

        def _parse_queued_until(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                queued_until_type_0 = datetime.datetime.fromisoformat(data)

                return queued_until_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        queued_until = _parse_queued_until(d.pop("queuedUntil", UNSET))

        target_node = d.pop("targetNode", UNSET)

        total_bytes = d.pop("totalBytes", UNSET)

        verified_bytes = d.pop("verifiedBytes", UNSET)

        operation_progress = cls(
            phase=phase,
            queued_until=queued_until,
            target_node=target_node,
            total_bytes=total_bytes,
            verified_bytes=verified_bytes,
        )

        operation_progress.additional_properties = d
        return operation_progress

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
