from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.hosted_port import HostedPort
    from ..models.listening_port import ListeningPort


T = TypeVar("T", bound="SandboxPorts")


@_attrs_define
class SandboxPorts:
    """
    Attributes:
        hosted (list[HostedPort]):
        listening (list[ListeningPort]):
        listening_observed_at (datetime.datetime | None): When `listening` was read from the agent; null when it is the
            last report stored for the sandbox (not ready or the agent is unreachable)
    """

    hosted: list[HostedPort]
    listening: list[ListeningPort]
    listening_observed_at: datetime.datetime | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        hosted = []
        for hosted_item_data in self.hosted:
            hosted_item = hosted_item_data.to_dict()
            hosted.append(hosted_item)

        listening = []
        for listening_item_data in self.listening:
            listening_item = listening_item_data.to_dict()
            listening.append(listening_item)

        listening_observed_at: None | str
        if isinstance(self.listening_observed_at, datetime.datetime):
            listening_observed_at = self.listening_observed_at.isoformat()
        else:
            listening_observed_at = self.listening_observed_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "hosted": hosted,
                "listening": listening,
                "listeningObservedAt": listening_observed_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.hosted_port import HostedPort  # noqa: PLC0415
        from ..models.listening_port import ListeningPort  # noqa: PLC0415

        d = dict(src_dict)
        hosted = []
        _hosted = d.pop("hosted")
        for hosted_item_data in _hosted:
            hosted_item = HostedPort.from_dict(hosted_item_data)

            hosted.append(hosted_item)

        listening = []
        _listening = d.pop("listening")
        for listening_item_data in _listening:
            listening_item = ListeningPort.from_dict(listening_item_data)

            listening.append(listening_item)

        def _parse_listening_observed_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                listening_observed_at_type_0 = datetime.datetime.fromisoformat(data)

                return listening_observed_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        listening_observed_at = _parse_listening_observed_at(d.pop("listeningObservedAt"))

        sandbox_ports = cls(
            hosted=hosted,
            listening=listening,
            listening_observed_at=listening_observed_at,
        )

        sandbox_ports.additional_properties = d
        return sandbox_ports

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
